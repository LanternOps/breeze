import { describe, it, expect } from 'vitest';
import { mfaDisableSchema } from './mfa';

// #4050 omitted ssoReauthGrantId from mfaDisableSchema because the handler
// never read it: currentPassword was mandatory and there was no passwordless
// road for the field to serve. #4045 adds that road — the handler now passes
// the field to resolveFactorManagementStepUp as the passwordless alternative to
// currentPassword — so the schema accepts it again, and both proofs are
// optional HERE: "neither supplied" is the resolver's own rejection
// (`sso_reauth_required` for a passwordless account, the opaque
// `invalid_credentials` otherwise), never a zod error whose shape would differ
// by account type.
describe('mfaDisableSchema (#4045)', () => {
  it('keeps ssoReauthGrantId (the handler now reads it)', () => {
    const result = mfaDisableSchema.safeParse({
      code: '123456',
      ssoReauthGrantId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        code: '123456',
        ssoReauthGrantId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      });
    }
  });

  it('rejects a malformed ssoReauthGrantId', () => {
    const result = mfaDisableSchema.safeParse({ code: '123456', ssoReauthGrantId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('leaves the password-vs-grant decision to the resolver (both optional at the schema)', () => {
    expect(mfaDisableSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(mfaDisableSchema.safeParse({ code: '123456', currentPassword: 'pw' }).success).toBe(true);
  });

  it('still requires code', () => {
    const result = mfaDisableSchema.safeParse({ currentPassword: 'x'.repeat(10) });
    expect(result.success).toBe(false);
  });
});
