/**
 * Access-review separation of duties.
 *
 * A reviewer may not decide (approve / revoke / reset) the review item that is
 * about their OWN access. The single exception is when nobody else could
 * decide it: if no OTHER user in the review's owning scope is an eligible
 * decider, the self-decision is allowed and recorded on the item
 * (`access_review_items.self_decided`) so the review record and its export
 * show that the control was not separated.
 *
 * "Eligible decider" mirrors exactly what `PATCH /access-reviews/:id/items/:itemId`
 * demands of a caller, evaluated for every other member of the scope:
 *
 *   - membership on the review's owner axis — `partner_users` for a
 *     partner-owned review, `organization_users` for an org-owned one. Only a
 *     partner-scope token reaches a partner review and only an org-scope token
 *     reaches an org review (routes/accessReviews.ts getScopeContext), so the
 *     other axis can never decide the item and is not counted;
 *   - the membership's role grants `users:write` (wildcards honoured, same
 *     matcher requirePermission uses);
 *   - partner reviews only: `org_access = 'all'` — the router-level gate
 *     (canManagePartnerWidePolicies) refuses every other partner member;
 *   - `users.status = 'active'`. An `invited` user has never accepted and
 *     cannot sign in; a `disabled` user cannot sign in. Neither can decide, so
 *     neither blocks the escape.
 *
 * MFA is deliberately NOT a disqualifier. The route's `requireMfa()` admits
 * any session that satisfies the user's effective MFA policy, and every active
 * user can reach one — a user whose policy requires a factor they have not
 * enrolled is sent through enrolment at sign-in and then holds an
 * `mfa: true` session. Counting "not enrolled yet" as "cannot decide" would let
 * an admin self-approve just because a co-admin had not set up MFA, which
 * widens the exception without the co-admin being unable to act.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { PERMISSION_GRANTS } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizationUsers, partnerUsers, permissions, rolePermissions, users } from '../db/schema';
import { permissionGrantMatches } from './permissionMatching';

export type AccessReviewOwner =
  | { scope: 'partner'; partnerId: string }
  | { scope: 'organization'; orgId: string };

export interface AccessReviewDeciderCandidate {
  userId: string;
  status: 'active' | 'invited' | 'disabled';
  /** partner_users.org_access; null for an organization membership. */
  orgAccess: 'all' | 'selected' | 'none' | null;
  grants: Array<{ resource: string; action: string }>;
}

const DECIDE_GRANT = PERMISSION_GRANTS.USERS_WRITE;

/** Pure eligibility rule — see the module comment for each clause. */
export function isEligibleAccessReviewDecider(
  owner: AccessReviewOwner,
  candidate: AccessReviewDeciderCandidate,
): boolean {
  if (candidate.status !== 'active') return false;
  if (owner.scope === 'partner' && candidate.orgAccess !== 'all') return false;
  return candidate.grants.some((grant) =>
    permissionGrantMatches(grant, DECIDE_GRANT.resource, DECIDE_GRANT.action),
  );
}

async function loadOtherCandidates(
  owner: AccessReviewOwner,
  selfUserId: string,
): Promise<AccessReviewDeciderCandidate[]> {
  const members: Array<{
    userId: string;
    roleId: string;
    status: AccessReviewDeciderCandidate['status'];
    orgAccess: AccessReviewDeciderCandidate['orgAccess'];
  }> =
    owner.scope === 'partner'
      ? await db
          .select({
            userId: partnerUsers.userId,
            roleId: partnerUsers.roleId,
            status: users.status,
            orgAccess: partnerUsers.orgAccess,
          })
          .from(partnerUsers)
          .innerJoin(users, eq(partnerUsers.userId, users.id))
          .where(and(eq(partnerUsers.partnerId, owner.partnerId), ne(partnerUsers.userId, selfUserId)))
      : (
          await db
            .select({
              userId: organizationUsers.userId,
              roleId: organizationUsers.roleId,
              status: users.status,
            })
            .from(organizationUsers)
            .innerJoin(users, eq(organizationUsers.userId, users.id))
            .where(and(eq(organizationUsers.orgId, owner.orgId), ne(organizationUsers.userId, selfUserId)))
        ).map((row) => ({ ...row, orgAccess: null }));

  // Only active members can ever qualify; skip the grant read for the rest.
  const active = members.filter((m) => m.status === 'active');
  if (active.length === 0) return [];

  const roleIds = Array.from(new Set(active.map((m) => m.roleId)));
  const grantRows = await db
    .select({ roleId: rolePermissions.roleId, resource: permissions.resource, action: permissions.action })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(inArray(rolePermissions.roleId, roleIds));

  const grantsByRole = new Map<string, Array<{ resource: string; action: string }>>();
  for (const row of grantRows) {
    const list = grantsByRole.get(row.roleId) ?? [];
    list.push({ resource: row.resource, action: row.action });
    grantsByRole.set(row.roleId, list);
  }

  return active.map((m) => ({
    userId: m.userId,
    status: m.status,
    orgAccess: m.orgAccess,
    grants: grantsByRole.get(m.roleId) ?? [],
  }));
}

/**
 * True when at least one user OTHER than `selfUserId` could decide an item on
 * a review owned by `owner`.
 *
 * Runs in a fresh system-scoped transaction. This is an identity question
 * about the whole scope, and the request's RLS context cannot answer it
 * faithfully: `users` is dual-axis RLS keyed on each user's HOME partner/org,
 * so a co-admin whose home tenant differs from this scope is filtered out of
 * the join — an undercount that would wrongly GRANT the self-decision escape
 * (fail-open). Every read is equality-keyed on the caller's own scope id
 * (taken from the authenticated token by the route, never from input), so the
 * escalation can only surface members of that one scope. Same rationale and
 * pattern as getUserPermissions (services/permissions.ts). The route calls
 * this only when the caller touches their own item or opens a review that
 * contains one, so the extra pooled connection is off the hot path.
 */
export async function hasOtherEligibleAccessReviewDecider(
  owner: AccessReviewOwner,
  selfUserId: string,
): Promise<boolean> {
  const candidates = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => loadOtherCandidates(owner, selfUserId)),
  );
  return candidates.some((c) => isEligibleAccessReviewDecider(owner, c));
}

/**
 * Whether `selfUserId` may decide their own item on a review owned by `owner`:
 * allowed only when nobody else in the scope is an eligible decider.
 */
export async function canSelfDecideAccessReviewItem(
  owner: AccessReviewOwner,
  selfUserId: string,
): Promise<boolean> {
  return !(await hasOtherEligibleAccessReviewDecider(owner, selfUserId));
}
