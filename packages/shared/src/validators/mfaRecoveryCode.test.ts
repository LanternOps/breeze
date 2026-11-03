import { describe, expect, it } from 'vitest';
import { isMfaRecoveryCode } from './mfaRecoveryCode';

describe('isMfaRecoveryCode', () => {
  it.each(['ABCD-1234', 'abcd-1234', '0000-ZZZZ', '  ABCD-1234  '])('accepts %j', (value) => {
    expect(isMfaRecoveryCode(value)).toBe(true);
  });

  it.each(['', '123456', 'ABCD1234', 'ABC-12345', 'ABCD-123', 'ABCD-12345', 'ABCD_1234', 'ABCD-12 34', 'ÄBCD-1234'])(
    'rejects %j',
    (value) => {
      expect(isMfaRecoveryCode(value)).toBe(false);
    },
  );
});
