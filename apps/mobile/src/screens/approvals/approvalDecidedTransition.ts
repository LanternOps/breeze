/**
 * #5172: ApprovalScreen's early-return "No pending approvals / You're all
 * caught up." branch used to fire the instant `focused` went missing — which
 * happens in the SAME tick a decision (approve/deny/report) resolves on the
 * last pending row (`dropAndRefocus` rolls `focusId` to null). The
 * "Approved · …" / "Denied · logged" toast is queued in that same moment,
 * but the toast lives below the early return in the component, so it never
 * rendered at all: the takeover just flashed the generic empty copy for as
 * long as the Modal's native dismiss transition takes, then disappeared.
 *
 * This is the single decision point for which branch ApprovalScreen renders.
 * The genuine empty state (nothing focused, no decision confirmation still
 * owed) is unaffected — it renders exactly when it used to.
 */
export function shouldShowEmptyApprovalState(inputs: {
  /** Is there currently a focused pending approval (see `approvalTakeover.ts`)? */
  focused: boolean;
  /** Is a just-decided approval's outcome toast still owed to the user? */
  decisionToastPending: boolean;
}): boolean {
  return !inputs.focused && !inputs.decisionToastPending;
}
