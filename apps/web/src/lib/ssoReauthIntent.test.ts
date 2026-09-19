import { beforeEach, describe, expect, it } from 'vitest';

import {
  SSO_REAUTH_INTENT_KEY,
  stashSsoReauthIntent,
  takeSsoReauthIntent,
} from './ssoReauthIntent';

describe('ssoReauthIntent (#4055)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips the intent across a full-page navigation', () => {
    stashSsoReauthIntent('passkey');

    expect(sessionStorage.getItem(SSO_REAUTH_INTENT_KEY)).toBe('passkey');
    expect(takeSsoReauthIntent()).toBe('passkey');
  });

  // The IdP round-trip is one-shot. A value left behind would misroute the
  // NEXT return — the exact class of bug #4055 is about.
  it('consumes the intent so a second read cannot replay it', () => {
    stashSsoReauthIntent('totp');

    expect(takeSsoReauthIntent()).toBe('totp');
    expect(takeSsoReauthIntent()).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_INTENT_KEY)).toBeNull();
  });

  it('returns null when nothing was stashed', () => {
    expect(takeSsoReauthIntent()).toBeNull();
  });

  // Anything outside the union is a stale or foreign value. It must not be
  // handed back as an intent, AND it must still be cleared — otherwise it sits
  // there poisoning every later read.
  it('rejects and clears an unrecognized stored value', () => {
    sessionStorage.setItem(SSO_REAUTH_INTENT_KEY, 'sms');

    expect(takeSsoReauthIntent()).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_INTENT_KEY)).toBeNull();
  });

  // Private-mode / quota / blocked-storage browsers throw on access. The intent
  // is a routing nicety; it must never take the enrollment flow down with it.
  it('never throws when sessionStorage is unavailable', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      expect(() => stashSsoReauthIntent('passkey')).not.toThrow();
      expect(takeSsoReauthIntent()).toBeNull();
    } finally {
      if (real) Object.defineProperty(window, 'sessionStorage', real);
    }
  });
});
