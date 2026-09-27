/**
 * Actions that may NEVER clear four_eyes through the sole-operator
 * self-approval fallback.
 *
 * The sole-operator branch lets a requester who is the ONLY eligible approver
 * approve their own four_eyes intent at assurance level 3. For a PAM
 * elevation that is self-granted local admin with no second person in the
 * trail, so these intents require a distinct approver or are refused:
 *
 *   - fan-out (`intentService.ts`): the requester-owned row is never created;
 *     the intent is cancelled with `no_eligible_approvers`.
 *   - decide (`approvals/decideApprovalRequest.ts`): a self-approve is
 *     refused with `self_approval_forbidden` (belt-and-braces over the
 *     fan-out). A self-DENY stays available.
 *
 * Kept in its own module (not `intentApprovers.ts`) because many suites mock
 * that module with an explicit factory, which would silently drop a new
 * export and turn the check into a TypeError.
 */
const SOLE_OPERATOR_SELF_APPROVAL_FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  'request_elevation',
]);

export function isSoleOperatorSelfApprovalForbidden(actionName: string): boolean {
  return SOLE_OPERATOR_SELF_APPROVAL_FORBIDDEN_ACTIONS.has(actionName);
}
