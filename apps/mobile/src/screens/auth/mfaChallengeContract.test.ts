import { describe, expect, it } from 'vitest';
import { normalizeMfaChallengeCode } from './mfaChallengeContract';

describe('MFA challenge input contract', () => {
  it('formats recovery codes as uppercase XXXX-XXXX', () => {
    expect(normalizeMfaChallengeCode('ab12cd34', 'recovery_code')).toBe('AB12-CD34');
    expect(normalizeMfaChallengeCode('ab12-cd34', 'recovery_code')).toBe('AB12-CD34');
  });

  it('keeps standard factors numeric and six digits', () => {
    expect(normalizeMfaChallengeCode('12a34567', 'totp')).toBe('123456');
  });
});
