import { describe, it, expect } from 'vitest';
import { mfaDisableSchema } from './mfa';

// #4050: mfaDisableSchema = mfaVerifySchema.extend({ currentPassword }) used to
// inherit ssoReauthGrantId from mfaVerifySchema and validate it successfully,
// even though the /mfa/disable handler never reads it (currentPassword is
// mandatory on this schema, unlike the enable/setup-confirm schemas, so there
// is no passwordless road through this route for the field to serve). The
// field is now explicitly omitted so the schema's shape says what the handler
// actually accepts.
describe('mfaDisableSchema (#4050 ssoReauthGrantId omission)', () => {
  it('strips ssoReauthGrantId from the parsed result even when supplied', () => {
    const result = mfaDisableSchema.safeParse({
      code: '123456',
      currentPassword: 'correct horse battery staple',
      ssoReauthGrantId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('ssoReauthGrantId');
      expect(result.data).toEqual({
        code: '123456',
        currentPassword: 'correct horse battery staple',
      });
    }
  });

  it('still requires currentPassword (unconditionally, unlike enable/setup-confirm)', () => {
    const result = mfaDisableSchema.safeParse({ code: '123456' });
    expect(result.success).toBe(false);
  });

  it('still requires code', () => {
    const result = mfaDisableSchema.safeParse({ currentPassword: 'x'.repeat(10) });
    expect(result.success).toBe(false);
  });
});
