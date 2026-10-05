/**
 * Execution-time re-check of the user who requested an org merge.
 *
 * `POST /orgs/organizations/:id/merge` (routes/orgMerge.ts) authorizes the
 * caller once, then hands `performedBy` to the org-merge queue. The worker can
 * run that job later — behind other merges on a concurrency-1 queue, or after a
 * restart — and nothing re-asked whether the requester was still allowed to
 * merge. This resolves the same three facts the route checked, from LIVE rows:
 *
 *   1. the user still exists and is `active`;
 *   2. the user is still bound to the merging partner — same `users.partner_id`
 *      plus a `partner_users` membership — or is a live platform admin (the
 *      system-scope path the route also admits);
 *   3. that authority still grants `organizations:write` (the route's
 *      `requireOrgWrite`) and, for a partner member, still reaches BOTH the
 *      loser and the survivor (the route's raw-selection reach check).
 *
 * Permissions are resolved with `getUserPermissions(..., { bypassCache: true })`
 * — the exact resolver `requirePermission` uses — so a grant means the same
 * thing here as at the route, and a revoked role cannot be answered from the
 * in-process permission cache. Run it inside a system DB context: the resolver
 * then reads on that context's own connection instead of escalating to a second
 * pooled one. (The `breeze_command_requester_*` SQL resolvers answer an
 * org-axis question from an agent's org-scoped context and prefer an
 * `organization_users` row; the merge route authorizes on the partner axis, and
 * a system context needs no SECURITY DEFINER bridge to read these rows.)
 *
 * MFA, which the route also requires, is a property of the request's session,
 * not of the user, so it cannot be re-derived for a queued job.
 *
 * Returns null when the performer still qualifies, otherwise a stable refusal
 * code. THROWS on a lookup failure — the caller must treat that as "could not
 * check" and not merge.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { canAccessOrg, getUserPermissions, hasPermission, PERMISSIONS, type UserPermissions } from './permissions';

export type MergePerformerRefusal =
  | 'performer_not_found'
  | 'performer_inactive'
  | 'performer_not_in_partner'
  | 'performer_lacks_permission'
  | 'performer_lacks_org_access';

export interface MergePerformerCheckInput {
  loserOrgId: string;
  survivorOrgId: string;
  partnerId: string;
  performedBy: string;
}

function grantsMerge(perms: UserPermissions): boolean {
  return hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
}

export async function resolveMergePerformerRefusal(
  input: MergePerformerCheckInput,
): Promise<MergePerformerRefusal | null> {
  const [user] = await db
    .select({
      id: users.id,
      status: users.status,
      partnerId: users.partnerId,
      isPlatformAdmin: users.isPlatformAdmin,
    })
    .from(users)
    .where(eq(users.id, input.performedBy))
    .limit(1);

  if (!user) return 'performer_not_found';
  if (user.status !== 'active') return 'performer_inactive';

  // System-scope path: re-derived from the live is_platform_admin flag by the
  // resolver itself, so a demoted admin gets null here.
  if (user.isPlatformAdmin === true) {
    const systemPerms = await getUserPermissions(input.performedBy, { scope: 'system' }, { bypassCache: true });
    if (systemPerms && systemPerms.scope === 'system' && grantsMerge(systemPerms)) return null;
  }

  if (user.partnerId !== input.partnerId) return 'performer_not_in_partner';

  const perms = await getUserPermissions(
    input.performedBy,
    { partnerId: input.partnerId, scope: 'partner' },
    { bypassCache: true },
  );
  if (!perms || perms.scope !== 'partner') return 'performer_not_in_partner';
  if (!grantsMerge(perms)) return 'performer_lacks_permission';
  if (!canAccessOrg(perms, input.loserOrgId) || !canAccessOrg(perms, input.survivorOrgId)) {
    return 'performer_lacks_org_access';
  }
  return null;
}
