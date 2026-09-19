import { describe, it, expect } from 'vitest';

import {
  APPROVAL_TOAST_OWNER,
  decisionToastFor,
  isDecisionToastVisible,
  shouldShowEmptyApprovalState,
} from './approvalDecidedTransition';

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

/**
 * #5172 root cause, precisely: `approve`/`deny` queue their confirmation
 * toast with `approvalId: <the just-decided row's own id>` — never `null` —
 * so a naive `toast.approvalId === focusedId` check goes false the instant
 * `dropAndRefocus` clears focus on the LAST pending row (focusedId becomes
 * undefined, but the toast's approvalId is a real, non-null string). That
 * silently dropped the primary approve/deny confirmation in exactly the
 * case this fix targets, while an `approvalId: null` toast (report outcome,
 * expiry, focus-swap guard) was unaffected. `isDecisionToastVisible` is the
 * single source of truth `ApprovalScreen` calls instead of an inline check,
 * so this contract can be tested directly.
 */
describe('isDecisionToastVisible', () => {
  it('is false with no toast', () => {
    expect(isDecisionToastVisible(null, 'a')).toBe(false);
    expect(isDecisionToastVisible(null, undefined)).toBe(false);
  });

  it('a screen-global toast (approvalId: null) is always visible', () => {
    expect(isDecisionToastVisible({ approvalId: null }, 'a')).toBe(true);
    expect(isDecisionToastVisible({ approvalId: null }, undefined)).toBe(true);
  });

  it('a toast for the currently-focused row is visible', () => {
    expect(isDecisionToastVisible({ approvalId: 'a' }, 'a')).toBe(true);
  });

  it('a toast for a DIFFERENT row than the one now focused is dropped (rolled to the next request)', () => {
    expect(isDecisionToastVisible({ approvalId: 'a' }, 'b')).toBe(false);
  });

  it('#5172: a toast for the just-decided row is visible when NOTHING is now focused (last item)', () => {
    expect(isDecisionToastVisible({ approvalId: 'a' }, undefined)).toBe(true);
  });
});

/**
 * #5368: the toast is now a single app-wide host, so ApprovalScreen has to
 * tell ITS toasts apart from every other screen's. `approvalId: null` used to
 * be a safe "screen-global" marker because only ApprovalScreen could post into
 * ApprovalScreen's own toast state; now TimerBar's "Synced 3 offline time
 * entries" and every other background toast also carries no sourceId, and
 * ApprovalGate deliberately keeps the navigator running underneath the
 * takeover — so without an owner tag a background toast would paint over a
 * live approval prompt, and would also hold the takeover off its empty state.
 */
describe('decisionToastFor', () => {
  it('is null when no toast is showing', () => {
    expect(decisionToastFor(null)).toBeNull();
  });

  it('is null for a toast posted by another screen', () => {
    expect(decisionToastFor({ owner: null, sourceId: null })).toBeNull();
    expect(decisionToastFor({ owner: 'systems', sourceId: null })).toBeNull();
  });

  it('passes an approval-owned toast through with its row id', () => {
    expect(decisionToastFor({ owner: APPROVAL_TOAST_OWNER, sourceId: 'appr-1' })).toEqual({
      approvalId: 'appr-1',
    });
  });

  it('keeps an approval-owned outcome error screen-global (no row id)', () => {
    expect(decisionToastFor({ owner: APPROVAL_TOAST_OWNER, sourceId: null })).toEqual({
      approvalId: null,
    });
  });
});
