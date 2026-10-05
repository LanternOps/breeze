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
 * Site / device-group restrictions on an org membership do not disqualify:
 * the PATCH route does not consult them.
 *
 * MFA is deliberately NOT a disqualifier. The route's `requireMfa()` admits
 * any session that satisfies the user's effective MFA policy, and every active
 * user can reach one — a user whose policy requires a factor they have not
 * enrolled is sent through enrolment at sign-in and then holds an
 * `mfa: true` session. Counting "not enrolled yet" as "cannot decide" would let
 * an admin self-approve just because a co-admin had not set up MFA, which
 * widens the exception without the co-admin being unable to act.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';

export type AccessReviewOwner =
  | { scope: 'partner'; partnerId: string }
  | { scope: 'organization'; orgId: string };

/**
 * True when at least one user OTHER than `selfUserId` could decide an item on
 * a review owned by `owner`.
 *
 * Resolved by `breeze_access_review_has_other_decider` (migration
 * 2026-12-05-100100), which encodes the eligibility rule above in SQL and
 * returns only a boolean. It runs on the request's own connection, inside its
 * transaction: the request's RLS context cannot answer the question itself
 * (`users` is dual-axis RLS keyed on each user's HOME partner/org, so a
 * co-admin whose home tenant differs from this scope would be filtered out of
 * the join — an undercount that would wrongly GRANT the exception), and a
 * nested system-context connection would double-hold the pool. The resolver
 * checks the caller's access to `owner` before elevating, and answers
 * fail-closed (true) when it is missing.
 *
 * A missing or non-boolean answer is treated as "someone else can decide",
 * and a resolver error propagates — neither ever grants the exception.
 */
export async function hasOtherEligibleAccessReviewDecider(
  owner: AccessReviewOwner,
  selfUserId: string,
): Promise<boolean> {
  const ownerId = owner.scope === 'partner' ? owner.partnerId : owner.orgId;
  const rows = (await db.execute(
    sql`SELECT public.breeze_access_review_has_other_decider(${owner.scope}, ${ownerId}::uuid, ${selfUserId}::uuid) AS has_other`,
  )) as unknown as Array<{ has_other: boolean | null }>;
  return rows[0]?.has_other !== false;
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
