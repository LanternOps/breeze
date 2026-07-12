import { describe, expect, it } from 'vitest';
import { normalizeMfaChallengeCode, resolveMfaCodeMethods } from './mfaChallengeContract';

describe('MFA challenge input contract', () => {
  it('formats recovery codes as uppercase XXXX-XXXX', () => {
    expect(normalizeMfaChallengeCode('ab12cd34', 'recovery_code')).toBe('AB12-CD34');
    expect(normalizeMfaChallengeCode('ab12-cd34', 'recovery_code')).toBe('AB12-CD34');
  });

  it('keeps standard factors numeric and six digits', () => {
    expect(normalizeMfaChallengeCode('12a34567', 'totp')).toBe('123456');
  });

  it('selects the first explicit code method when the primary is mismatched', () => {
    expect(resolveMfaCodeMethods('totp', ['sms', 'recovery_code'])).toEqual({
      methods: ['sms', 'recovery_code'], selected: 'sms',
    });
  });

  it.each([
    [['passkey'], { methods: [], selected: null }],
    [[], { methods: [], selected: null }],
    [['unsupported', null], { methods: [], selected: null }],
    [null, { methods: [], selected: null }],
  ])('fails closed for unsupported explicit methods %#', (allowed, expected) => {
    expect(resolveMfaCodeMethods('passkey', allowed)).toEqual(expected);
  });
});
