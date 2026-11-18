import { describe, it, expect } from 'vitest';

import type { MfaChallenge } from '../../services/api';
import { getInitialNativeMfaMethod, shouldAutoSubmitMfa } from './mfaChallengePresentation';

describe('shouldAutoSubmitMfa', () => {
  it('submits once the authenticator code reaches 6 digits', () => {
    expect(shouldAutoSubmitMfa({ method: 'totp', codeLength: 6, alreadyAutoSubmitted: false })).toBe(true);
  });

  it('does not submit before 6 digits', () => {
    expect(shouldAutoSubmitMfa({ method: 'totp', codeLength: 5, alreadyAutoSubmitted: false })).toBe(false);
  });

  it('debounces — does not re-submit the same 6-digit code twice (paste/autofill)', () => {
    expect(shouldAutoSubmitMfa({ method: 'totp', codeLength: 6, alreadyAutoSubmitted: true })).toBe(false);
  });

  it('never auto-submits for SMS — only the authenticator method', () => {
    expect(shouldAutoSubmitMfa({ method: 'sms', codeLength: 6, alreadyAutoSubmitted: false })).toBe(false);
  });

  it('never auto-submits recovery codes', () => {
    expect(shouldAutoSubmitMfa({ method: 'recovery', codeLength: 6, alreadyAutoSubmitted: false })).toBe(false);
  });
});

describe('getInitialNativeMfaMethod', () => {
  it('falls back to totp for a passkey-primary account with a TOTP backup', () => {
    const challenge: MfaChallenge = {
      tempToken: 't',
      mfaMethod: 'passkey',
      methods: ['totp', 'passkey'],
      allowedMethods: { totp: true, sms: false, passkey: true },
      recoveryAvailable: false,
      phoneLast4: null,
    };
    expect(getInitialNativeMfaMethod(challenge)).toBe('totp');
  });
});
