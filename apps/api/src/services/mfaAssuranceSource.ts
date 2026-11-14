/**
 * How a session's `mfa: true` claim was earned (spec 2026-09-18 device
 * move-org step-up, D6). Groundwork only — no gate reads this yet.
 *
 *   factor — Breeze itself verified a factor in this session's lineage
 *            (TOTP / SMS / recovery-code login, passkey login, enrollment
 *            mints, the Breeze-verified arm of the SSO link ceremony).
 *   idp    — `mfa: true` rests on a TRUSTED EXTERNAL assertion (CF Access
 *            `trustsMfa`, SSO `trustsIdpMfa` + amr).
 *   policy — `mfa: true` because the effective MFA policy did not require a
 *            factor (password login, registration auto-login, accept-invite,
 *            and the no-factor/policy-not-required arm of CF Access and SSO).
 *
 * SSO produces `policy` for a user who holds NO Breeze factor under a policy
 * that does not require one (#11889), the same arm the password login takes.
 * When a trusted IdP assertion is also present the source is 'idp'.
 *
 * A token with NO `mfa_src` predates this claim; any consumer MUST read
 * absent as `policy` (the conservative reading). `mfa: false` tokens carry
 * no `mfa_src` at all.
 */
export type MfaAssuranceSource = 'factor' | 'idp' | 'policy';

export const MFA_ASSURANCE_SOURCES: readonly MfaAssuranceSource[] = ['factor', 'idp', 'policy'];

export function isMfaAssuranceSource(value: unknown): value is MfaAssuranceSource {
  return typeof value === 'string' && (MFA_ASSURANCE_SOURCES as readonly string[]).includes(value);
}

/** The claim to mint alongside `mfa: assured`: the source when assured, else absent. */
export function mfaSrcFor(assured: boolean, source: MfaAssuranceSource): MfaAssuranceSource | undefined {
  return assured ? source : undefined;
}

export interface NoFactorSessionMfa {
  /** The session's `mfa` claim. */
  mfa: boolean;
  /** The session's `mfa_src` claim: 'policy' when assured, else absent. */
  mfaSrc: MfaAssuranceSource | undefined;
  /** The account holds no factor and its policy requires one: lock the session to enrollment. */
  mfaEnrollmentRequired: boolean;
}

/**
 * The MFA claim for a session minted with NO factor proven in this request:
 * password login past its enrolled-account branch, registration auto-login,
 * and accept-invite (#11854). One definition, so these mint paths cannot
 * disagree for the same user under the same policy.
 *
 *   2FA disabled deployment-wide              → assured ('policy');
 *   account holds a factor it did not prove   → not assured;
 *   no factor, effective policy requires MFA  → not assured, enrollment required;
 *   no factor, effective policy does not      → assured ('policy').
 *
 * `mfa: true` here is policy admission, never factor proof (see requireMfa in
 * middleware/auth.ts for what that gate does and does not promise).
 */
export function resolveNoFactorSessionMfa(input: {
  twoFactorEnabled: boolean;
  userMfaEnabled: boolean;
  policyRequired: boolean;
}): NoFactorSessionMfa {
  const mfaEnrollmentRequired = input.twoFactorEnabled && !input.userMfaEnabled && input.policyRequired;
  const mfa = !input.twoFactorEnabled || (!input.userMfaEnabled && !input.policyRequired);
  return { mfa, mfaSrc: mfaSrcFor(mfa, 'policy'), mfaEnrollmentRequired };
}
