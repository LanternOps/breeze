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
 *            factor (password login, registration auto-login, the
 *            no-factor/policy-not-required arms of CF Access and SSO).
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
