import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, users } from '../db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  buildOrgAccessClosures,
  computeAccessibleOrgIds,
  siteAccessCheck,
  type AuthContext,
} from '../middleware/auth';
import { canAccessOrg, getUserPermissions } from './permissions';
import { checkToolPermissionForResolvedUser } from './aiGuardrails';
import type { ActiveSession } from './streamingSessionManager';

export type LiveSessionAuthorityResult =
  | { ok: true; auth: AuthContext; toolAuth: AuthContext }
  | { ok: false; reason: string };

type LiveAuthoritySession = Pick<ActiveSession, 'auth' | 'toolAuth' | 'orgId' | 'deviceId'>;

/**
 * Pin a device-bound session's TOOL authority to the device's own organization.
 *
 * A session opened against a device must never let a tool reach beyond that
 * device's org, however wide the user's own reach is (#3087). This narrowing is
 * applied to EVERY branch below, including the platform-admin/system branch —
 * a device-bound platform admin is still bound to the device.
 */
function deviceBoundToolAuth(auth: AuthContext, session: LiveAuthoritySession): AuthContext {
  if (!session.deviceId) return auth;
  return {
    ...auth,
    orgId: session.orgId,
    accessibleOrgIds: [session.orgId],
    ...buildOrgAccessClosures([session.orgId]),
  };
}

/**
 * Rebuild a human AI session's authority immediately before delayed release.
 *
 * WIDENING POLICY — what this function may and may not grant:
 *  - It re-reads authority from the database; it never trusts the session
 *    snapshot. Any reduction (user deactivated, role changed, permissions
 *    bumped, site ceiling narrowed, org suspended/deleted/moved) denies.
 *  - The ONLY widening it can produce is an `isPlatformAdmin` promotion that
 *    is true in the database right now. An organization-scoped session can
 *    NEVER become partner-scoped: `partnerId` is only passed to
 *    `getUserPermissions` when the session was already partner-scoped. A
 *    partner-scoped session MAY fall back to a direct org membership after its
 *    partner membership is removed — that is a narrowing.
 *  - Platform admins deliberately skip `checkToolPermissionForResolvedUser`;
 *    the platform-admin grant is the policy, and a system-scoped session has
 *    no tenant permission set to check against.
 *
 * DELIBERATE CARVE-OUTS — paths that do NOT call this:
 *  - Tier 1 (read-only, no approval) is not revalidated: there is no delay
 *    between the authority check and the call, so there is no window to close.
 *  - Helper sessions are governed by PAM, not by this snapshot (Phase 1,
 *    security finding A), and are handled before the tier-2 branches.
 *  - The tier-3 durable-intent path validates via
 *    `revalidateApprovedIntentForRelease` and does not rebuild `toolAuth`.
 */
export async function resolveLiveSessionToolAuthority(
  session: LiveAuthoritySession,
  toolName: string,
  input: Record<string, unknown>,
): Promise<LiveSessionAuthorityResult> {
  if (session.auth.principal?.kind !== 'user_session') {
    return { ok: false, reason: 'Interactive session authority could not be verified' };
  }

  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [user] = await db.select({
      status: users.status,
      isPlatformAdmin: users.isPlatformAdmin,
    }).from(users).where(eq(users.id, session.auth.user.id)).limit(1);
    if (!user || user.status !== 'active') return { ok: false, reason: 'User is no longer active' };

    if (session.auth.scope === 'system') {
      if (!user.isPlatformAdmin) return { ok: false, reason: 'Platform authority was removed' };
      // Platform admins skip checkToolPermissionForResolvedUser by policy: the
      // platform-admin grant IS the authorization, and a system-scoped session
      // has no tenant permission set to resolve against.
      const auth = { ...session.auth, user: { ...session.auth.user, isPlatformAdmin: true } };
      return { ok: true, auth, toolAuth: deviceBoundToolAuth(auth, session) };
    }

    // Re-resolve the target tenant before membership. The session's partnerId
    // and org reach are snapshots; an organization can move, suspend, or be
    // deleted while a Tier-2 approval is pending.
    //
    // Deliberately NOT row-locked. A FOR SHARE here releases when this system
    // context commits — minutes before the tool actually runs — so it buys no
    // TOCTOU protection while blocking concurrent organization UPDATEs for the
    // duration of the read (same class of mistake as #5541). This is a
    // point-in-time read by design; it shrinks the stale-authority window from
    // "whole session" to "this release", it does not eliminate it.
    const [organization] = await db.select({
      id: organizations.id,
      partnerId: organizations.partnerId,
    }).from(organizations).where(and(
      eq(organizations.id, session.orgId),
      inArray(organizations.status, ['active', 'trial']),
      isNull(organizations.deletedAt),
    )).limit(1);
    if (!organization) return { ok: false, reason: 'Organization authority was removed' };

    // An organization-scoped session must not promote itself to the partner
    // axis. A partner-scoped session may safely fall back to a direct current
    // org membership after its partner membership is removed.
    const perms = await getUserPermissions(session.auth.user.id, {
      orgId: session.orgId,
      partnerId: session.auth.scope === 'partner' ? organization.partnerId : undefined,
      bypassCache: true,
    });
    if (!perms || !canAccessOrg(perms, session.orgId)) {
      return { ok: false, reason: 'Organization authority was removed' };
    }

    const liveScope = perms.scope;
    const livePartnerId = liveScope === 'partner' ? organization.partnerId : null;
    const liveOrgId = liveScope === 'organization' ? session.orgId : null;
    const reach = liveScope === 'partner'
      ? await computeAccessibleOrgIds('partner', livePartnerId, null, session.auth.user.id)
      : { orgIds: [session.orgId], partnerOrgAccess: null };
    const accessibleOrgIds = reach.orgIds ?? [];
    if ((liveScope === 'partner' && reach.partnerOrgAccess === null)
      || !accessibleOrgIds.includes(session.orgId)) {
      return { ok: false, reason: 'Organization authority was removed' };
    }
    const closures = buildOrgAccessClosures(accessibleOrgIds);
    const auth: AuthContext = {
      ...session.auth,
      user: { ...session.auth.user, isPlatformAdmin: user.isPlatformAdmin },
      token: session.auth.token ? {
        ...session.auth.token,
        roleId: perms.roleId,
        scope: liveScope,
        partnerId: livePartnerId,
        orgId: liveOrgId,
      } : null,
      scope: liveScope,
      partnerId: livePartnerId,
      orgId: liveOrgId,
      accessibleOrgIds,
      partnerOrgAccess: liveScope === 'partner' ? reach.partnerOrgAccess : null,
      allowedSiteIds: perms.allowedSiteIds,
      canAccessSite: siteAccessCheck(perms.allowedSiteIds),
      ...closures,
    };
    const permissionError = checkToolPermissionForResolvedUser(toolName, input, perms);
    if (permissionError) return { ok: false, reason: permissionError };

    return { ok: true, auth, toolAuth: deviceBoundToolAuth(auth, session) };
  }));
}
