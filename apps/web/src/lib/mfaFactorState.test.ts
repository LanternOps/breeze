import { describe, expect, it } from 'vitest';

import { totpEnrolledAfterPrimaryChange } from './mfaFactorState';

describe('totpEnrolledAfterPrimaryChange (#10650)', () => {
  it.each([
    [{ mfaEnabled: false, mfaMethod: null }, true, false],
    [{ mfaEnabled: true, mfaMethod: 'totp' }, false, true],
    [{ mfaEnabled: true, mfaMethod: 'totp' }, undefined, true],
    [{ mfaEnabled: true, mfaMethod: 'sms' }, true, false],
    // A passkey add/delete leaves the authenticator as it was.
    [{ mfaEnabled: true, mfaMethod: 'passkey' }, true, true],
    [{ mfaEnabled: true, mfaMethod: 'passkey' }, false, false],
    [{ mfaEnabled: true, mfaMethod: 'passkey' }, undefined, undefined],
  ] as const)('%j with previous=%s → %s', (state, previous, expected) => {
    expect(totpEnrolledAfterPrimaryChange(state, previous)).toBe(expected);
  });
});
