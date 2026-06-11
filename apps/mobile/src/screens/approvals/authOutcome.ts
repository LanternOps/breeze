/**
 * Classification of a failed biometric/passcode confirmation on the
 * approval consent action (PR #696 / issue #746).
 *
 * Extracted as pure logic (no RN/Expo imports) so the mobile Vitest
 * harness (node env, .test.ts files only) can cover it, same pattern as
 * decisionTarget.ts. The component owns flow (passcode fallback, success);
 * this module owns "what, if anything, do we tell the user when auth did
 * not succeed".
 */

export type AuthFailureKind = 'silent' | 'interrupted' | 'lockout' | 'failed';

export interface AuthFailureClassification {
  kind: AuthFailureKind;
  /** User-facing message. `null` means show nothing (justified no-op). */
  message: string | null;
}

// Only an explicit user-initiated cancel (tapped Cancel / dismissed the
// sheet) is a justified silent no-op — the user chose not to proceed.
const SILENT_CANCEL_CODE = 'user_cancel';

// system_cancel / app_cancel fire when the OS or app interrupts the
// prompt — backgrounding, or a SECOND push notification arriving
// mid-confirmation (exactly the race class PR #745 addresses). The
// consent attempt was silently dropped; the user may believe they
// approved. This MUST surface with an actionable retry, not be swallowed.
const INTERRUPTED_CODES = new Set(['system_cancel', 'app_cancel']);

const LOCKOUT_CODES = new Set(['lockout', 'lockout_permanent']);

/**
 * Map an `expo-local-authentication` failure `error` code to what the
 * user should see. `code` is `result.error` from a non-success
 * LocalAuthenticationResult (may be undefined).
 */
export function classifyAuthFailure(code: string | undefined): AuthFailureClassification {
  if (code === SILENT_CANCEL_CODE) {
    return { kind: 'silent', message: null };
  }
  if (code && INTERRUPTED_CODES.has(code)) {
    return {
      kind: 'interrupted',
      message: 'Confirmation was interrupted. Tap Approve to try again.',
    };
  }
  if (code && LOCKOUT_CODES.has(code)) {
    return {
      kind: 'lockout',
      message: 'Biometrics locked. Use device passcode in Settings to unlock.',
    };
  }
  return { kind: 'failed', message: 'Authentication failed. Try again.' };
}
