import { describe, it, expect } from 'vitest';

import { shouldShowEmptyApprovalState } from './approvalDecidedTransition';

/**
 * #5172: ApprovalScreen's `!focused` branch rendered "No pending approvals /
 * You're all caught up." the instant a decision (approve/deny) resolved on
 * the LAST pending row — dropAndRefocus clears `focused` in the same tick
 * the "Approved · …" toast is queued, so the takeover flashed the empty
 * copy for as long as the Modal's native dismiss takes, and the decision
 * confirmation never appeared at all (the toast lived below this early
 * return). The genuine empty state (nothing pending, no toast owed) must
 * still render correctly.
 */
describe('shouldShowEmptyApprovalState', () => {
  it('never shows empty state while a row is focused', () => {
    expect(shouldShowEmptyApprovalState({ focused: true, decisionToastPending: false })).toBe(false);
    expect(shouldShowEmptyApprovalState({ focused: true, decisionToastPending: true })).toBe(false);
  });

  it('holds off the empty state while a decision toast is still owed', () => {
    expect(shouldShowEmptyApprovalState({ focused: false, decisionToastPending: true })).toBe(false);
  });

  it('shows the genuine empty state once nothing is focused and no toast is owed', () => {
    expect(shouldShowEmptyApprovalState({ focused: false, decisionToastPending: false })).toBe(true);
  });
});
