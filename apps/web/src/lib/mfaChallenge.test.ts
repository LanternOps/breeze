import { describe, expect, it } from 'vitest';
import { parseMfaChallengeResponse } from './mfaChallenge';

const base = {
  mfaRequired: true,
  tempToken: 'temp-token',
  mfaMethod: 'totp',
  allowedMethods: { totp: true, sms: false, passkey: true },
  recoveryAvailable: true,
  passkeyAvailable: true,
  phoneLast4: null,
};

describe('parseMfaChallengeResponse', () => {
  it('normalizes the authoritative method set', () => {
    expect(parseMfaChallengeResponse(base)).toEqual({
      tempToken: 'temp-token',
      primary: 'totp',
      methods: ['totp', 'passkey', 'recovery'],
      allowedMethods: { totp: true, sms: false, passkey: true },
      recoveryAvailable: true,
      phoneLast4: null,
    });
  });

  it('selects recovery for a recovery-only new challenge', () => {
    expect(parseMfaChallengeResponse({
      ...base,
      allowedMethods: { totp: false, sms: false, passkey: false },
      recoveryAvailable: true,
      passkeyAvailable: false,
    })?.primary).toBe('recovery');
  });

  it.each([
    { ...base, allowedMethods: undefined },
    { ...base, recoveryAvailable: undefined },
    { ...base, allowedMethods: { totp: 1, sms: false, passkey: true } },
    { ...base, recoveryAvailable: 'yes' },
    { ...base, passkeyAvailable: false },
    { ...base, mfaMethod: 'recovery' },
    { ...base, allowedMethods: { totp: false, sms: false, passkey: false }, recoveryAvailable: false, passkeyAvailable: false },
  ])('rejects malformed or unusable new contracts', (value) => {
    expect(parseMfaChallengeResponse(value)).toBeNull();
  });

  it.each([
    [{ mfaRequired: true, tempToken: 't', mfaMethod: 'totp' }, ['totp']],
    [{ mfaRequired: true, tempToken: 't', mfaMethod: 'sms', phoneLast4: '1234' }, ['sms']],
    [{ mfaRequired: true, tempToken: 't', mfaMethod: 'passkey', passkeyAvailable: true }, ['passkey']],
    [{ mfaRequired: true, tempToken: 't', mfaMethod: 'totp', passkeyAvailable: true }, ['totp', 'passkey']],
  ])('supports a well-formed legacy response', (value, methods) => {
    expect(parseMfaChallengeResponse(value)?.methods).toEqual(methods);
  });
});
