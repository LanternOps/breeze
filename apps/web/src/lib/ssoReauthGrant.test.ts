import { beforeEach, describe, expect, it } from 'vitest';

import {
  SSO_REAUTH_GRANT_CLIENT_TTL_MS,
  SSO_REAUTH_GRANT_KEY,
  clearSsoReauthGrant,
  readSsoReauthGrant,
  stashSsoReauthGrant,
} from './ssoReauthGrant';

const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const USER = 'user-1';
const T0 = 1_800_000_000_000;

describe('ssoReauthGrant (#8862)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('carries the grant and its intent across a remount', () => {
    stashSsoReauthGrant(GRANT, 'passkey', USER, T0);

    expect(readSsoReauthGrant(USER, T0 + 1_000)).toEqual({ grantId: GRANT, intent: 'passkey' });
  });

  // A remount is not a spend: register/options validates without consuming,
  // and the page may mount again before the user presses anything.
  it('does not consume on read', () => {
    stashSsoReauthGrant(GRANT, 'passkey', USER, T0);

    readSsoReauthGrant(USER, T0 + 1_000);
    expect(readSsoReauthGrant(USER, T0 + 2_000)).toEqual({ grantId: GRANT, intent: 'passkey' });
  });

  it('keeps a null intent (the pre-#4055 TOTP road) as null', () => {
    stashSsoReauthGrant(GRANT, null, USER, T0);

    expect(readSsoReauthGrant(USER, T0)).toEqual({ grantId: GRANT, intent: null });
  });

  it('is gone once cleared, so a spent grant is never offered again', () => {
    stashSsoReauthGrant(GRANT, 'passkey', USER, T0);
    clearSsoReauthGrant();

    expect(readSsoReauthGrant(USER, T0)).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });

  // The server TTL (300 s from mint) is the real backstop; the client TTL must
  // never outlive it, or a remount would arm the card with a dead proof.
  it('keeps a client TTL no longer than the 300 s server TTL', () => {
    expect(SSO_REAUTH_GRANT_CLIENT_TTL_MS).toBeGreaterThan(0);
    expect(SSO_REAUTH_GRANT_CLIENT_TTL_MS).toBeLessThanOrEqual(300_000);
  });

  it('expires after the client TTL and clears the stale entry', () => {
    stashSsoReauthGrant(GRANT, 'passkey', USER, T0);

    expect(readSsoReauthGrant(USER, T0 + SSO_REAUTH_GRANT_CLIENT_TTL_MS - 1)).not.toBeNull();
    expect(readSsoReauthGrant(USER, T0 + SSO_REAUTH_GRANT_CLIENT_TTL_MS)).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });

  // The grant is bound to the account (and session) that minted it. A
  // different account signing in on the same tab must not inherit it.
  it('is not handed to a different user, and is cleared', () => {
    stashSsoReauthGrant(GRANT, 'passkey', USER, T0);

    expect(readSsoReauthGrant('user-2', T0)).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });

  // An unhydrated auth store is not evidence the grant is foreign: decline,
  // but keep it for a read that can check.
  it('is not restored when the current user is unknown, and is kept', () => {
    stashSsoReauthGrant(GRANT, 'passkey', USER, T0);

    expect(readSsoReauthGrant(null, T0)).toBeNull();
    expect(readSsoReauthGrant(USER, T0)).toEqual({ grantId: GRANT, intent: 'passkey' });
  });

  it('records nothing when the minting user is unknown', () => {
    stashSsoReauthGrant(GRANT, 'passkey', null, T0);

    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });

  it.each([
    ['not JSON', '{nope'],
    ['a non-UUID grant id', JSON.stringify({ grantId: 'abc', intent: 'passkey', userId: USER, expiresAt: T0 + 60_000 })],
    ['an unknown intent', JSON.stringify({ grantId: GRANT, intent: 'sms', userId: USER, expiresAt: T0 + 60_000 })],
    ['a missing expiry', JSON.stringify({ grantId: GRANT, intent: 'passkey', userId: USER })],
    ['an expiry beyond the client TTL', JSON.stringify({ grantId: GRANT, intent: 'passkey', userId: USER, expiresAt: T0 + 3_600_000 })],
  ])('rejects and clears %s', (_label, raw) => {
    sessionStorage.setItem(SSO_REAUTH_GRANT_KEY, raw);

    expect(readSsoReauthGrant(USER, T0)).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });

  it('never throws when sessionStorage is unavailable', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      expect(() => stashSsoReauthGrant(GRANT, 'passkey', USER, T0)).not.toThrow();
      expect(readSsoReauthGrant(USER, T0)).toBeNull();
      expect(() => clearSsoReauthGrant()).not.toThrow();
    } finally {
      if (real) Object.defineProperty(window, 'sessionStorage', real);
    }
  });
});
