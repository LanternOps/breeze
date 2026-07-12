import { afterEach, describe, expect, it, vi } from 'vitest';

describe('auth feature flag defaults', () => {
  const originalEnableRegistration = process.env.ENABLE_REGISTRATION;

  afterEach(() => {
    if (originalEnableRegistration === undefined) delete process.env.ENABLE_REGISTRATION;
    else process.env.ENABLE_REGISTRATION = originalEnableRegistration;
    vi.resetModules();
  });

  it('defaults public registration off unless explicitly enabled', async () => {
    delete process.env.ENABLE_REGISTRATION;
    vi.resetModules();

    const { ENABLE_REGISTRATION } = await import('./schemas');

    expect(ENABLE_REGISTRATION).toBe(false);
  });

  it('allows explicit public registration opt-in', async () => {
    process.env.ENABLE_REGISTRATION = 'true';
    vi.resetModules();

    const { ENABLE_REGISTRATION } = await import('./schemas');

    expect(ENABLE_REGISTRATION).toBe(true);
  });
});

describe('MFA step-up and protected enrollment schemas', () => {
  it('requires exactly one passkey registration authorization reference', async () => {
    const { passkeyRegisterOptionsSchema } = await import('./schemas');
    expect(passkeyRegisterOptionsSchema.safeParse({ currentPassword: 'password' }).success).toBe(true);
    expect(passkeyRegisterOptionsSchema.safeParse({ mfaGrant: 'g'.repeat(43) }).success).toBe(true);
    expect(passkeyRegisterOptionsSchema.safeParse({}).success).toBe(false);
    expect(passkeyRegisterOptionsSchema.safeParse({
      currentPassword: 'password',
      mfaGrant: 'g'.repeat(43),
    }).success).toBe(false);
  });

  it('uses discriminated TOTP/SMS/passkey proof payloads', async () => {
    const { mfaStepUpVerifySchema } = await import('./schemas');
    const base = { purpose: 'passkey.register' };
    expect(mfaStepUpVerifySchema.safeParse({ ...base, method: 'totp', code: '123456' }).success).toBe(true);
    expect(mfaStepUpVerifySchema.safeParse({ ...base, method: 'sms', code: '123456' }).success).toBe(true);
    expect(mfaStepUpVerifySchema.safeParse({
      ...base,
      method: 'passkey',
      credential: { id: 'existing-credential', response: {} },
    }).success).toBe(true);
    expect(mfaStepUpVerifySchema.safeParse({ ...base, method: 'passkey', code: '123456' }).success).toBe(false);
    expect(mfaStepUpVerifySchema.safeParse({ ...base, method: 'totp', credential: {} }).success).toBe(false);
  });

  it('rejects unsupported purposes and recovery-code proofs', async () => {
    const { mfaStepUpOptionsSchema, mfaStepUpVerifySchema } = await import('./schemas');
    expect(mfaStepUpOptionsSchema.safeParse({ purpose: 'unknown', method: 'totp' }).success).toBe(false);
    expect(mfaStepUpVerifySchema.safeParse({
      purpose: 'passkey.register',
      method: 'recovery_code',
      code: 'ABCD-EFGH',
    }).success).toBe(false);
  });
});
