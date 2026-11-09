import { describe, expect, it } from 'vitest';
import { pickEffectivePortalAccessPolicy } from '../../services/portalAccessPolicy';
import { isBrowserSessionAllowed, parseStoredPortalSession } from './browserSession';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const USER = '11111111-2222-4333-8444-555566667777';
const base = { portalUserId: USER, orgId: ORG, authEpoch: 3 };

/** Effective policies built by the real pick, so the gate is tested against real field shapes. */
const CAPS_ALL = { entra: true, google: true, selfRegistration: false };
const empty = { entraEnabled: null, googleEnabled: null, passwordMode: null, selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null };
const allowedPolicy = pickEffectivePortalAccessPolicy(null, null, CAPS_ALL);
const ssoOnlyEntra = pickEffectivePortalAccessPolicy({ ...empty, entraEnabled: true, passwordMode: 'sso_only' }, null, CAPS_ALL);
const googleOnly = pickEffectivePortalAccessPolicy({ ...empty, googleEnabled: true }, null, CAPS_ALL);

const passwordUser = { authMethod: 'password', browserAccess: 'granted' };

describe('parseStoredPortalSession', () => {
  it('parses a pre-W3 payload without method as password', () => {
    expect(parseStoredPortalSession({ ...base, createdAt: '2026-11-01T00:00:00.000Z' })).toEqual({ ...base, method: 'password' });
  });

  it('keeps each known method and drops unrelated fields', () => {
    for (const method of ['password', 'entra', 'google'] as const) {
      expect(parseStoredPortalSession({ ...base, method, createdAt: 'x', token: 't' })).toEqual({ ...base, method });
    }
  });

  it('rejects an unknown method and a non-integer authEpoch', () => {
    expect(parseStoredPortalSession({ ...base, method: 'saml' })).toBeNull();
    expect(parseStoredPortalSession({ ...base, method: null })).toBeNull();
    expect(parseStoredPortalSession({ ...base, method: 1 })).toBeNull();
    expect(parseStoredPortalSession({ ...base, authEpoch: 1.5 })).toBeNull();
    expect(parseStoredPortalSession({ ...base, authEpoch: '3' })).toBeNull();
    expect(parseStoredPortalSession({ ...base, authEpoch: 0 })).toBeNull();
    expect(parseStoredPortalSession({ portalUserId: USER, orgId: ORG })).toBeNull();
  });

  it('rejects a bad shape', () => {
    for (const raw of [null, undefined, 'session', 42, [], { ...base, portalUserId: 7 }, { ...base, orgId: null }]) {
      expect(parseStoredPortalSession(raw)).toBeNull();
    }
  });
});

describe('isBrowserSessionAllowed', () => {
  it('password session needs password-eligible + browser granted + passwordMode allowed', () => {
    expect(isBrowserSessionAllowed({ method: 'password' }, passwordUser, allowedPolicy)).toBe(true);
    // Each leg alone refuses.
    expect(isBrowserSessionAllowed({ method: 'password' }, { ...passwordUser, authMethod: 'entra' }, allowedPolicy)).toBe(false);
    expect(isBrowserSessionAllowed({ method: 'password' }, { ...passwordUser, browserAccess: 'none' }, allowedPolicy)).toBe(false);
    expect(ssoOnlyEntra.effective.passwordMode.value).toBe('sso_only');
    expect(isBrowserSessionAllowed({ method: 'password' }, passwordUser, ssoOnlyEntra)).toBe(false);
  });

  it('an entra or google session needs browser granted and its own method allowed (not password eligibility)', () => {
    const entraUser = { authMethod: 'entra', browserAccess: 'granted' };
    expect(isBrowserSessionAllowed({ method: 'entra' }, entraUser, ssoOnlyEntra)).toBe(true);
    expect(isBrowserSessionAllowed({ method: 'entra' }, { ...entraUser, browserAccess: 'none' }, ssoOnlyEntra)).toBe(false);
    expect(isBrowserSessionAllowed({ method: 'entra' }, entraUser, allowedPolicy)).toBe(false);
    expect(isBrowserSessionAllowed({ method: 'google' }, entraUser, googleOnly)).toBe(true);
    expect(isBrowserSessionAllowed({ method: 'google' }, entraUser, ssoOnlyEntra)).toBe(false);
  });

  it('fails closed for a method it does not know', () => {
    expect(isBrowserSessionAllowed({ method: 'saml' as never }, passwordUser, allowedPolicy)).toBe(false);
  });
});
