/**
 * Wisp W04 Task 3 — validate the `wispGrantId` a chat session is opened under.
 *
 * Called by `createSession` (services/aiAgent.ts) once the session org is
 * known. Order and codes are the contract (W04 plan, Task 3):
 *
 *   wisp_disabled 404 → grant_not_found 404 → grant_not_yours 403 →
 *   grant_inactive 409 → entitlement_required 403 → grant_scope_mismatch 400
 *
 * (`focus_mismatch` 409 is raised by createSession's focus anchoring.)
 *
 * Why the grant row is read under SYSTEM context: `wisp_grants` is a
 * partner-axis table (shape 3, `breeze_has_partner_access(partner_id)`), and
 * an ORGANIZATION-scoped token carries no partner-axis access
 * (`accessiblePartnerIds = []`), so it cannot see its own grant. A partner-wide
 * grant opened from an org token must still work and anchor to the token's org
 * (W04 Review Focus 4). The system read is by primary key only, and the row is
 * trusted only after the same gates a partner-scoped request would apply:
 *   - the grant's partner equals the SESSION ORG's partner (the org already
 *     passed `canAccessOrg` in createSession) — otherwise `grant_not_found`, so
 *     another tenant's grant id is indistinguishable from a missing one;
 *   - `grantorUserId === auth.user.id` — otherwise `grant_not_yours`.
 * Together these are exactly what the DB guard trigger
 * `ai_sessions_wisp_grant_tenant_guard` enforces at insert time, so a
 * validated request never trips it.
 */
import { eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { wispGrants } from '../../db/schema/wisp';
import { wispEnabled } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';

export type WispSessionErrorCode =
  | 'wisp_disabled'
  | 'grant_not_found'
  | 'grant_not_yours'
  | 'grant_inactive'
  | 'entitlement_required'
  | 'grant_scope_mismatch'
  /** w00 A24: an explicit org (or bound device) other than the thread's focus org, or a focus this sign-in cannot reach. */
  | 'focus_mismatch'
  /** The grant's revision pin is broken (grantAuthority `kind: 'corrupt'`) — data damage, logged and captured. */
  | 'grant_corrupt';

export type WispSessionErrorStatus = 400 | 403 | 404 | 409 | 500;

/** User-visible messages (the route returns them verbatim). */
const DEFAULT_MESSAGES: Record<WispSessionErrorCode, string> = {
  wisp_disabled: 'Wisp is not available on this server.',
  grant_not_found: 'That Wisp grant was not found.',
  grant_not_yours: 'This Wisp grant belongs to another user. Open Wisp with your own grant.',
  grant_inactive: 'This Wisp grant is paused, revoked or expired. Resume or renew it before starting a conversation.',
  entitlement_required: 'Wisp is available on Pro and higher plans.',
  grant_scope_mismatch: 'This Wisp grant does not cover the organization this conversation would use.',
  focus_mismatch:
    'This Wisp conversation is focused on a different organization. Reload the page or change the focus, then try again.',
  grant_corrupt: "This Wisp grant can't be used. Turn Wisp off and on again.",
};

export class WispSessionError extends Error {
  constructor(
    public readonly code: WispSessionErrorCode,
    public readonly status: WispSessionErrorStatus,
    message?: string,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'WispSessionError';
  }
}

export type ValidatedWispGrant = { grantId: string; revisionId: string; partnerId: string; orgId: string | null };

/** Same shape as grantAuthority's helper: reuse an ambient system context, else leave the request context first. */
function inSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

export async function validateWispGrantForSession(
  auth: AuthContext,
  wispGrantId: string,
  sessionOrgId: string,
): Promise<ValidatedWispGrant> {
  if (!wispEnabled()) throw new WispSessionError('wisp_disabled', 404);

  const loaded = await inSystemContext(async () => {
    const [grant] = await db
      .select({
        id: wispGrants.id,
        partnerId: wispGrants.partnerId,
        orgId: wispGrants.orgId,
        grantorUserId: wispGrants.grantorUserId,
        grantee: wispGrants.grantee,
        currentRevisionId: wispGrants.currentRevisionId,
        status: wispGrants.status,
        expiresAt: wispGrants.expiresAt,
      })
      .from(wispGrants)
      .where(eq(wispGrants.id, wispGrantId))
      .limit(1);
    if (!grant) return null;
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, sessionOrgId))
      .limit(1);
    return { grant, sessionPartnerId: org?.partnerId ?? null };
  });

  // "Not readable under the request context": missing, not a Wisp grant, or a
  // grant of another partner than the session's org (see the file header).
  if (!loaded || loaded.grant.grantee !== 'wisp' || loaded.grant.partnerId !== loaded.sessionPartnerId) {
    throw new WispSessionError('grant_not_found', 404);
  }
  const { grant } = loaded;

  if (grant.grantorUserId !== auth.user.id) throw new WispSessionError('grant_not_yours', 403);

  // `expires_at` passes before the expiry sweep flips the status; a grant with
  // no current revision has no ceiling to pin. Both are unusable now.
  if (grant.status !== 'active' || grant.expiresAt.getTime() <= Date.now() || !grant.currentRevisionId) {
    throw new WispSessionError('grant_inactive', 409);
  }

  // Lazy: the entitlement resolver's graph (cluster cache bus) is not needed by
  // every importer of the route that maps WispSessionError.
  const { hasEntitlement } = await import('../entitlements');
  if (!(await hasEntitlement(grant.partnerId, 'wisp'))) throw new WispSessionError('entitlement_required', 403);

  const validated: ValidatedWispGrant = {
    grantId: grant.id,
    revisionId: grant.currentRevisionId,
    partnerId: grant.partnerId,
    orgId: grant.orgId ?? null,
  };
  assertGrantCoversSessionOrg(validated, sessionOrgId);
  return validated;
}

/**
 * An org-scoped grant covers only its own org; a partner-wide grant (orgId
 * null) covers any org of its partner (the partner match is checked above).
 * createSession calls this again when focus anchoring moved the session org.
 */
export function assertGrantCoversSessionOrg(validated: ValidatedWispGrant, sessionOrgId: string): void {
  if (validated.orgId !== null && validated.orgId !== sessionOrgId) {
    throw new WispSessionError('grant_scope_mismatch', 400);
  }
}
