import { describe, expect, it } from 'vitest';
import { normalizeEnrollmentMethods } from './forcedMfaContract';

describe('normalizeEnrollmentMethods', () => {
  it('keeps only unique enrollable methods in canonical order', () => {
    expect(normalizeEnrollmentMethods(['passkey', 'sms', 'passkey', 'recovery_code', 'totp']))
      .toEqual(['totp', 'sms', 'passkey']);
  });

  it.each([undefined, null, {}, [], ['recovery_code'], ['bogus']])(
    'fails closed for malformed or empty input %#',
    (value) => expect(normalizeEnrollmentMethods(value)).toEqual([]),
  );
});
