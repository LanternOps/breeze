/**
 * The partner member's RAW per-org selection (`partner_users.org_ids`) — the one
 * access source that survives an org leaving the live status set.
 *
 * `computeAccessibleOrgIds` (middleware/auth.ts) narrows a partner member to
 * `status IN ('active','trial')`, so a suspended, offboarding, merging,
 * archived or purging org is absent from `auth.accessibleOrgIds` and
 * `auth.canAccessOrg()` returns false for it — for EVERY member of the partner,
 * whatever their selection. Routes that must reach such an org (they load it
 * under a system context on purpose) therefore cannot use `canAccessOrg` as the
 * boundary, and partner-id equality alone is NOT a substitute: a member with
 * `org_access='selected'` shares the caller's partner yet may hold no rights to
 * this specific org at all.
 *
 * `routes/orgs.ts`'s `canApplySuspendedOrgLifecycleTransition` established this
 * exact re-read for the suspended case (#2879); this module is that mechanism
 * extracted so the archive/restore endpoints and the archived-org reads apply
 * the same boundary instead of re-deriving it.
 *
 * Fails CLOSED: `org_access='none'` and an unresolved membership both reach
 * "no orgs", never "all orgs".
 */
import { and, eq, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, partnerUsers } from '../db/schema';
import { UNASSIGNED_POOL_ORG_TYPE } from './unassignedPool/orgType';

export interface PartnerOrgSelectionAuth {
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  partnerOrgAccess?: 'all' | 'selected' | 'none' | null;
  user: { id: string };
}

/**
 * The member's selection list, read under a fresh system context. Every
 * predicate is keyed by the caller's OWN userId + partnerId, so this can only
 * surface facts about the caller's own membership.
 */
export async function readPartnerSelectedOrgIds(
  userId: string,
  partnerId: string,
): Promise<string[]> {
  const [membership] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ orgIds: partnerUsers.orgIds })
        .from(partnerUsers)
        .where(and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, partnerId)))
        .limit(1),
    ),
  );
  return membership?.orgIds ?? [];
}

/**
 * What a partner-scope caller may reach among orgs that are invisible to RLS.
 *
 * - `all`       — every org of the caller's own partner EXCEPT the partner's
 *                 holding org (`unassigned_pool`), which is never reachable
 *                 through a generic org surface. `resolvePartnerOrgReach`
 *                 cannot express that exclusion in its return value, so a
 *                 caller that consumes `allOfPartner` directly must refuse
 *                 holding orgs itself (org merge: `validateMergePair`; org
 *                 archive: `beginOrgArchive`). `partnerMemberMayReachOrg`
 *                 applies it for you.
 * - `selected`  — only the ids in the caller's selection.
 * - `none`      — nothing (this is the fail-closed default for an unresolved
 *                 membership too).
 */
export type PartnerOrgReach =
  | { kind: 'allOfPartner' }
  | { kind: 'selection'; orgIds: string[] }
  | { kind: 'none' };

export async function resolvePartnerOrgReach(
  auth: PartnerOrgSelectionAuth,
): Promise<PartnerOrgReach> {
  if (!auth.partnerId) return { kind: 'none' };
  if (auth.partnerOrgAccess === 'all') return { kind: 'allOfPartner' };
  if (auth.partnerOrgAccess === 'selected') {
    return { kind: 'selection', orgIds: await readPartnerSelectedOrgIds(auth.user.id, auth.partnerId) };
  }
  return { kind: 'none' };
}

/**
 * True when a PARTNER-scope caller retains rights to this specific org even
 * though it is outside `accessibleOrgIds`: the member's selection admits it,
 * AND the org belongs to the caller's own partner, AND it is not the partner's
 * holding org (the holding org is never
 * human-reachable, and an `org_access='all'` member would otherwise reach it
 * here). The org lookup runs under a fresh system context because the target
 * is, by construction, invisible to the caller's RLS context. Fails closed: a
 * missing, foreign or holding org is "not reachable".
 */
export async function partnerMemberMayReachOrg(
  auth: PartnerOrgSelectionAuth,
  orgId: string,
): Promise<boolean> {
  const reach = await resolvePartnerOrgReach(auth);
  if (reach.kind === 'none') return false;
  if (reach.kind === 'selection' && !reach.orgIds.includes(orgId)) return false;
  const partnerId = auth.partnerId!;
  const [org] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, partnerId),
          ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
        ))
        .limit(1),
    ),
  );
  return Boolean(org);
}
