import { afterEach, describe, expect, it, vi } from 'vitest';
import { mfaVerifySchema, mfaStepUpSchema } from './schemas';

// SR2-09: mfaVerifySchema must accept a 6-digit TOTP/SMS code OR the
// `XXXX-XXXX` recovery-code form, and the `method` enum must include
// 'recovery'. The handler (mfa.ts) routes on `method`, not on shape alone.
describe('mfaVerifySchema (SR2-09 recovery-code login)', () => {
  it('accepts a 6-digit code with method: totp', () => {
    const result = mfaVerifySchema.safeParse({ code: '123456', method: 'totp' });
    expect(result.success).toBe(true);
  });

  it('accepts an XXXX-XXXX recovery code with method: recovery', () => {
    const result = mfaVerifySchema.safeParse({ code: 'ABCD-2345', method: 'recovery' });
    expect(result.success).toBe(true);
  });

  it('accepts a lowercase recovery code (normalization happens in the handler)', () => {
    const result = mfaVerifySchema.safeParse({ code: 'abcd-2345', method: 'recovery' });
    expect(result.success).toBe(true);
  });

  it('rejects a code that is neither 6 digits nor XXXX-XXXX', () => {
    const result = mfaVerifySchema.safeParse({ code: 'not-a-code' });
    expect(result.success).toBe(false);
  });

  it('rejects a method outside totp/sms/recovery', () => {
    const result = mfaVerifySchema.safeParse({ code: '123456', method: 'push' });
    expect(result.success).toBe(false);
  });
});

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

describe('mfaStepUpSchema operation field', () => {
  it('defaults operation to add_factor on every branch', () => {
    const totp = mfaStepUpSchema.parse({ method: 'totp', code: '123456' });
    expect(totp.operation).toBe('add_factor');
    const passkey = mfaStepUpSchema.parse({ method: 'passkey', credential: { id: 'cred-1' } });
    expect(passkey.operation).toBe('add_factor');
  });

  it('accepts register_approver_device', () => {
    const parsed = mfaStepUpSchema.parse({
      method: 'totp',
      code: '123456',
      operation: 'register_approver_device',
    });
    expect(parsed.operation).toBe('register_approver_device');
  });

  it('rejects unknown operations', () => {
    expect(() =>
      mfaStepUpSchema.parse({ method: 'totp', code: '123456', operation: 'admin_takeover' })
    ).toThrow();
  });

  // #4018: enroll_first_factor is a REAL StepUpOperation, so the `satisfies`
  // constraint on STEP_UP_OPERATIONS would happily accept it being added to
  // the client-requestable list — nothing in the type system stops that. But
  // it is minted ONLY by the SSO re-auth callback, after a forced IdP
  // round-trip proves identity for a passwordless account. If a client could
  // request it here, anyone who can already satisfy step-up could mint one
  // without ever re-authenticating. This test is the guard the type system
  // does not provide.
  it('rejects enroll_first_factor — SSO-reauth-mint only, never client-requestable', () => {
    expect(() =>
      mfaStepUpSchema.parse({ method: 'totp', code: '123456', operation: 'enroll_first_factor' })
    ).toThrow();
  });

  // RMM-QA-176 D11 (T12): entering/extending device maintenance mode is a
  // client-requestable step-up operation, and its resource binding must be
  // accepted by this schema. The duration cap is imported from the grant
  // service, so a value the device route would refuse can never mint a grant.
  it('accepts device_maintenance with a maintenance resource binding', () => {
    const parsed = mfaStepUpSchema.parse({
      method: 'totp',
      code: '123456',
      operation: 'device_maintenance',
      resource: { deviceIds: ['00000000-0000-4000-8000-000000000010'], reason: 'scheduled patching', durationHours: 4 },
    });
    expect(parsed.operation).toBe('device_maintenance');
    expect(parsed.resource).toMatchObject({ durationHours: 4, reason: 'scheduled patching' });
  });

  it('rejects a maintenance resource with a duration above the shared cap', () => {
    expect(() =>
      mfaStepUpSchema.parse({
        method: 'totp',
        code: '123456',
        operation: 'device_maintenance',
        resource: { deviceIds: ['00000000-0000-4000-8000-000000000010'], reason: 'scheduled patching', durationHours: 169 },
      })
    ).toThrow();
  });
});
