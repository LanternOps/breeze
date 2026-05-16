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
 * Capture the request id at press time (before biometric), then pass it
 * here with the currently-focused approval at decision time. Returns the
 * approval to act on only if the captured id still matches a focused,
 * still-pending request; otherwise null — the caller MUST abort and ask
 * the user to review again rather than silently deciding the wrong action.
 */
export function decisionTarget<T extends { id: string; status: string }>(
  capturedId: string,
  focused: T | undefined,
): T | null {
  if (!focused) return null;
  if (focused.id !== capturedId) return null;
  if (focused.status !== 'pending') return null;
  return focused;
}
