import { describe, expect, it } from 'vitest';
import type { MfaChallenge } from '../../services/api';
import {
  getInitialNativeMfaMethod,
  getSupportedNativeMfaMethods,
  normalizeNativeMfaInput,
  normalizeNativeMfaSubmission,
} from './mfaChallengePresentation';

function challenge(overrides: Partial<MfaChallenge> = {}): MfaChallenge {
  return {
    tempToken: 'temp-1',
    mfaMethod: 'totp',
    methods: ['totp'],
    allowedMethods: { totp: true, sms: false, passkey: false },
    recoveryAvailable: false,
    phoneLast4: null,
    ...overrides,
  };
}

describe('MfaChallengeScreen presentation contract', () => {
  it('filters passkey from native choices while keeping recovery', () => {
    expect(getSupportedNativeMfaMethods(challenge({
      methods: ['totp', 'sms', 'passkey', 'recovery'],
    }))).toEqual(['totp', 'sms', 'recovery']);
  });

  it('returns no initial method for a passkey-only challenge', () => {
    const value = challenge({
      mfaMethod: 'passkey',
      methods: ['passkey'],
      allowedMethods: { totp: false, sms: false, passkey: true },
    });
    expect(getInitialNativeMfaMethod(value)).toBeNull();
  });

  it('falls back from a passkey primary to the first supported native method', () => {
    const value = challenge({ mfaMethod: 'passkey', methods: ['passkey', 'recovery'] });
    expect(getInitialNativeMfaMethod(value)).toBe('recovery');
  });

  it('keeps only six numeric digits for TOTP and SMS', () => {
    expect(normalizeNativeMfaInput('totp', '12a34 567')).toBe('123456');
    expect(normalizeNativeMfaInput('sms', '98-76')).toBe('9876');
  });

  it('preserves recovery separators and trims only outer whitespace on submit', () => {
    const raw = '  ABCD EFGH-IJKL  ';
    expect(normalizeNativeMfaInput('recovery', raw)).toBe(raw);
    expect(normalizeNativeMfaSubmission('recovery', raw)).toBe('ABCD EFGH-IJKL');
  });
});
