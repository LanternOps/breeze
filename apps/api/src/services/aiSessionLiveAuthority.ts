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

/** Rebuild a human AI session's authority immediately before delayed release. */
export async function resolveLiveSessionToolAuthority(
  session: Pick<ActiveSession, 'auth' | 'toolAuth' | 'orgId' | 'deviceId'>,
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
      const auth = { ...session.auth, user: { ...session.auth.user, isPlatformAdmin: true } };
      return { ok: true, auth, toolAuth: auth };
    }

    // Re-resolve the target tenant before membership. The session's partnerId
    // and org reach are snapshots; an organization can move, suspend, or be
    // deleted while a Tier-2 approval is pending.
    const [organization] = await db.select({
      id: organizations.id,
      partnerId: organizations.partnerId,
    }).from(organizations).where(and(
      eq(organizations.id, session.orgId),
      inArray(organizations.status, ['active', 'trial']),
      isNull(organizations.deletedAt),
    )).limit(1).for('share');
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

    const toolAuth: AuthContext = session.deviceId
      ? {
          ...auth,
          orgId: session.orgId,
          accessibleOrgIds: [session.orgId],
          ...buildOrgAccessClosures([session.orgId]),
        }
      : auth;
    return { ok: true, auth, toolAuth };
  }));
}
