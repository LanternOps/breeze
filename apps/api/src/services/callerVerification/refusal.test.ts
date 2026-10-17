import { describe, expect, it } from 'vitest';
import { CallerVerificationRequiredError } from './errors';
import { callerRefusal, callerRefusalFromPayload } from './refusal';

describe('callerRefusal', () => {
  const payload = {
    orgId: '11111111-1111-4111-8111-111111111111', contactId: null,
    action: 'disable_user' as const, requiredTier: 2, reason: 'no_fresh_verification' as const, latest: null,
  };

  it('preserves the actionable refusal without error internals', () => {
    expect(callerRefusal(new CallerVerificationRequiredError(payload)))
      .toEqual({ error: 'Caller verification required', requiresCallerVerification: payload });
  });

  it('returns null for any other error, never leaking its message', () => {
    expect(callerRefusal(new Error('database secret'))).toBeNull();
    expect(callerRefusal('string')).toBeNull();
    expect(callerRefusal(undefined)).toBeNull();
  });

  it('builds the same object from a stored payload', () => {
    expect(callerRefusalFromPayload(payload)).toEqual(callerRefusal(new CallerVerificationRequiredError(payload)));
  });
});
