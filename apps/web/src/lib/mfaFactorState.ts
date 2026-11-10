/**
 * #10650: what an MFA primary-state change implies for `totpEnrolled`.
 *
 * `mfaMethod` names only the PRIMARY factor, so after a factor write the
 * client knows the new primary but not always whether an authenticator app is
 * still enrolled. The cases the API can produce:
 *
 * - MFA off: no factor survives (the API clears the secret on every MFA-off
 *   transition), so nothing is enrolled.
 * - TOTP primary: the authenticator IS the primary.
 * - SMS primary: SMS enable clears the secret by design.
 * - Passkey primary: a passkey add or delete never touches the authenticator,
 *   so whatever was known before still holds. Removing the authenticator
 *   itself is the one passkey-primary transition that changes it, and that
 *   caller sets `false` explicitly.
 */
export function totpEnrolledAfterPrimaryChange(
  state: { mfaEnabled: boolean; mfaMethod: string | null | undefined },
  previous: boolean | undefined,
): boolean | undefined {
  if (!state.mfaEnabled) return false;
  if (state.mfaMethod === 'totp') return true;
  if (state.mfaMethod === 'sms') return false;
  return previous;
}
