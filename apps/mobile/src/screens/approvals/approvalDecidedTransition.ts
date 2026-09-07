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

/**
 * Whether a queued toast should be shown right now.
 *
 * `approve`/`deny` queue their confirmation with `approvalId: <the decided
 * row's own id>` — a real, non-null string, never `null`. A naive
 * `toast.approvalId === focusedId` check therefore goes false the instant
 * `dropAndRefocus` clears focus on the LAST pending row (`focusedId` becomes
 * `undefined`, but the toast's id is not) — silently dropping the exact
 * confirmation #5172 is about. `approvalId: null` is reserved for toasts
 * that are screen-global by design (report-suspicious outcome, expiry,
 * focus-swap guard) and are always shown regardless of focus.
 *
 * The remaining case — a toast for a row OTHER than the one now focused
 * (focus rolled forward to the NEXT pending request, not to nothing) — stays
 * dropped on purpose: see the `toast` state doc in ApprovalScreen.tsx for why
 * (the wash/shake animation is the confirmation that survives a focus swap,
 * not the toast).
 */
export function isDecisionToastVisible(
  toast: { approvalId: string | null } | null,
  focusedId: string | undefined
): boolean {
  if (!toast) return false;
  if (toast.approvalId === null) return true;
  if (focusedId === undefined) return true;
  return toast.approvalId === focusedId;
}
