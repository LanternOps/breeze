import { describe, expect, it } from 'vitest';
import { resolveNoFactorSessionMfa } from './mfaAssuranceSource';

// #11854: login, registration auto-login and accept-invite all mint through
// this one function, so the same user under the same policy gets the same
// session MFA claim whichever path minted it.
describe('resolveNoFactorSessionMfa', () => {
  it('policy-admits a no-factor account when policy does not require MFA', () => {
    expect(resolveNoFactorSessionMfa({ twoFactorEnabled: true, userMfaEnabled: false, policyRequired: false }))
      .toEqual({ mfa: true, mfaSrc: 'policy', mfaEnrollmentRequired: false });
  });

  it('locks a no-factor account to enrollment when policy requires MFA', () => {
    expect(resolveNoFactorSessionMfa({ twoFactorEnabled: true, userMfaEnabled: false, policyRequired: true }))
      .toEqual({ mfa: false, mfaSrc: undefined, mfaEnrollmentRequired: true });
  });

  it('never assures an account holding a factor it did not prove, whatever the policy', () => {
    for (const policyRequired of [false, true]) {
      expect(resolveNoFactorSessionMfa({ twoFactorEnabled: true, userMfaEnabled: true, policyRequired }))
        .toEqual({ mfa: false, mfaSrc: undefined, mfaEnrollmentRequired: false });
    }
  });

  it('assures every session when 2FA is disabled deployment-wide', () => {
    for (const userMfaEnabled of [false, true]) {
      for (const policyRequired of [false, true]) {
        expect(resolveNoFactorSessionMfa({ twoFactorEnabled: false, userMfaEnabled, policyRequired }))
          .toEqual({ mfa: true, mfaSrc: 'policy', mfaEnrollmentRequired: false });
      }
    }
  });
});
