import type { ApprovalStatus } from '../../services/approvals';

/**
 * A request id snapshotted at the moment the user pressed Approve/Deny,
 * BEFORE the biometric modal opened. The brand makes it a compile error to
 * pass a freshly-read `focused.id` as the captured id — that misuse would
 * silently defeat the entire consent guard (a live id always "matches"
 * itself). The only way to obtain one is `captureRequestId()`, which names
 * the press-time intent at the single correct call site.
 */
export type CapturedRequestId = string & { readonly __capturedAtPress: unique symbol };

/** Brand a request id at press time. Call this BEFORE the biometric prompt. */
export function captureRequestId(id: string): CapturedRequestId {
  return id as CapturedRequestId;
}

/**
 * Consent-binding guard for approval decisions (PR #696 Critical #3).
 *
 * The biometric prompt (LocalAuthentication.authenticateAsync) is a
 * multi-second OS modal. While it is up, a second push, a tapped
 * notification, or a list refresh can change which approval is focused.
 * The user authenticated to decide the request they SAW; we must submit
 * exactly that request — never whatever happens to be focused when the
 * modal resolves.
 *
 * Capture the request id at press time via captureRequestId() (before
 * biometric), then pass it here with the currently-focused approval at
 * decision time. Returns the approval to act on only if the captured id
 * still matches a focused, still-pending request; otherwise null — the
 * caller MUST abort and ask the user to review again rather than silently
 * deciding the wrong action.
 *
 * Safety relies on an API invariant enforced outside this module: an
 * approval id is immutable and a request never returns to `pending` after
 * leaving it (the approvals reaper / approvalRecursion — PR #743). If an id
 * could be re-pended with different action content, an id+status match
 * would no longer prove the user saw that exact action.
 */
export function decisionTarget<T extends { id: string; status: ApprovalStatus }>(
  capturedId: CapturedRequestId,
  focused: T | undefined,
): T | null {
  if (!focused) return null;
  if (focused.id !== capturedId) return null;
  if (focused.status !== 'pending') return null;
  return focused;
}
