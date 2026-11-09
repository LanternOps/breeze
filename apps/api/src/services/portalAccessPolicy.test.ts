import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalAccessPolicyRowValues, PortalSignInCapabilities } from '@breeze/shared';

const dbState = vi.hoisted(() => ({
  inContext: false,
  selectResults: [] as unknown[][],
  systemContextCalls: 0,
}));

vi.mock('../db', () => {
  const nextChain = () => {
    const result = dbState.selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return chain;
  };
  return {
    db: { select: vi.fn(() => nextChain()) },
    hasDbAccessContext: () => dbState.inContext,
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      dbState.systemContextCalls += 1;
      return fn();
    }),
  };
});

import {
  PORTAL_ACCESS_POLICY_DEFAULTS,
  PortalAccessPolicyOrgNotFoundError,
  __testOnly,
  getPortalSignInCapabilities,
  isSignInMethodAllowed,
  pickEffectivePortalAccessPolicy,
  resolvePortalAccessPolicy,
} from './portalAccessPolicy';

const blank: PortalAccessPolicyRowValues = {
  entraEnabled: null, googleEnabled: null, passwordMode: null,
  selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null,
};
const NO_CAPS: PortalSignInCapabilities = { entra: false, google: false, selfRegistration: false };
const ALL_CAPS: PortalSignInCapabilities = { entra: true, google: true, selfRegistration: true };

const ORG_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const PARTNER_ID = '9f8e7d6c-5b4a-4f3e-9d2c-1b0a9f8e7d6c';

beforeEach(() => {
  dbState.inContext = false;
  dbState.selectResults = [];
  dbState.systemContextCalls = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  __testOnly.setCapabilities(null);
});

describe('pickEffectivePortalAccessPolicy', () => {
  it('defaults when neither row exists: password allowed, sso approval, 12 h, everything else off', () => {
    const r = pickEffectivePortalAccessPolicy(null, null, ALL_CAPS);
    expect(r.effective).toEqual({
      entraEnabled: { value: false, source: 'default' },
      googleEnabled: { value: false, source: 'default' },
      passwordMode: { value: 'allowed', source: 'default' },
      selfRegistrationMode: { value: 'off', source: 'default' },
      ssoNewPersonMode: { value: 'approval', source: 'default' },
      ssoSessionMaxHours: { value: 12, source: 'default' },
    });
    expect(r.passwordModeFallback).toBe(false);
    expect(PORTAL_ACCESS_POLICY_DEFAULTS).toEqual({
      entraEnabled: false, googleEnabled: false, passwordMode: 'allowed',
      selfRegistrationMode: 'off', ssoNewPersonMode: 'approval', ssoSessionMaxHours: 12,
    });
    // All-null rows are inherit, not values.
    expect(pickEffectivePortalAccessPolicy(blank, blank, ALL_CAPS).effective).toEqual(r.effective);
  });

  it('org false beats partner true; org null inherits partner; partner null falls to default (source per field)', () => {
    const partner = { ...blank, entraEnabled: true, googleEnabled: true, ssoNewPersonMode: 'instant' as const, ssoSessionMaxHours: 24 };
    const org = { ...blank, entraEnabled: false, ssoSessionMaxHours: 8 };
    const r = pickEffectivePortalAccessPolicy(org, partner, ALL_CAPS);
    expect(r.effective.entraEnabled).toEqual({ value: false, source: 'org' });
    expect(r.effective.googleEnabled).toEqual({ value: true, source: 'partner' });
    expect(r.effective.ssoNewPersonMode).toEqual({ value: 'instant', source: 'partner' });
    expect(r.effective.ssoSessionMaxHours).toEqual({ value: 8, source: 'org' });
    expect(r.effective.passwordMode).toEqual({ value: 'allowed', source: 'default' });
    expect(r.effective.selfRegistrationMode).toEqual({ value: 'off', source: 'default' });
  });

  it('masks entra/google/self-registration when the capability is off, keeping the picked source', () => {
    const org = { ...blank, entraEnabled: true, selfRegistrationMode: 'instant' as const };
    const partner = { ...blank, googleEnabled: true };
    const masked = pickEffectivePortalAccessPolicy(org, partner, NO_CAPS);
    expect(masked.effective.entraEnabled).toEqual({ value: false, source: 'org' });
    expect(masked.effective.googleEnabled).toEqual({ value: false, source: 'partner' });
    expect(masked.effective.selfRegistrationMode).toEqual({ value: 'off', source: 'org' });

    const open = pickEffectivePortalAccessPolicy(org, partner, ALL_CAPS);
    expect(open.effective.entraEnabled).toEqual({ value: true, source: 'org' });
    expect(open.effective.googleEnabled).toEqual({ value: true, source: 'partner' });
    expect(open.effective.selfRegistrationMode).toEqual({ value: 'instant', source: 'org' });
  });

  it('sso_only with no effective SSO method falls back to allowed and reports passwordModeFallback', () => {
    // Review Focus 4: the org says sso_only; the partner turned its (inherited) entra off.
    const org = { ...blank, passwordMode: 'sso_only' as const };
    const partner = { ...blank, entraEnabled: false };
    const r = pickEffectivePortalAccessPolicy(org, partner, ALL_CAPS);
    expect(r.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(r.passwordModeFallback).toBe(true);

    // Entra on in the row but the deployment cannot run it: masked off, so the fallback still applies.
    const masked = pickEffectivePortalAccessPolicy({ ...org, entraEnabled: true }, null, NO_CAPS);
    expect(masked.effective.passwordMode.value).toBe('allowed');
    expect(masked.passwordModeFallback).toBe(true);
  });

  it('sso_only with entra on and caps.entra stays sso_only', () => {
    const r = pickEffectivePortalAccessPolicy(
      { ...blank, passwordMode: 'sso_only' }, { ...blank, entraEnabled: true },
      { entra: true, google: false, selfRegistration: false },
    );
    expect(r.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(r.passwordModeFallback).toBe(false);

    const viaGoogle = pickEffectivePortalAccessPolicy(
      null, { ...blank, passwordMode: 'sso_only', googleEnabled: true },
      { entra: false, google: true, selfRegistration: false },
    );
    expect(viaGoogle.effective.passwordMode).toEqual({ value: 'sso_only', source: 'partner' });
    expect(viaGoogle.passwordModeFallback).toBe(false);
  });

  it('fingerprint changes when an effective value changes and not when only a masked raw value changes', () => {
    const base = pickEffectivePortalAccessPolicy(null, null, NO_CAPS).fingerprint;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic.
    expect(pickEffectivePortalAccessPolicy(null, null, NO_CAPS).fingerprint).toBe(base);
    // A masked raw value (entra on, but no capability) leaves every effective value unchanged.
    expect(pickEffectivePortalAccessPolicy({ ...blank, entraEnabled: true }, null, NO_CAPS).fingerprint).toBe(base);
    // A source-only change (org now states the default explicitly) is not a policy change either.
    expect(pickEffectivePortalAccessPolicy({ ...blank, ssoSessionMaxHours: 12 }, null, NO_CAPS).fingerprint).toBe(base);
    // A real effective change moves it.
    expect(pickEffectivePortalAccessPolicy({ ...blank, ssoSessionMaxHours: 13 }, null, NO_CAPS).fingerprint).not.toBe(base);
    expect(pickEffectivePortalAccessPolicy({ ...blank, entraEnabled: true }, null, { ...NO_CAPS, entra: true }).fingerprint)
      .not.toBe(base);
  });

  it('isSignInMethodAllowed maps password/entra/google to the effective fields', () => {
    const none = pickEffectivePortalAccessPolicy(null, null, ALL_CAPS);
    expect(isSignInMethodAllowed(none, 'password')).toBe(true);
    expect(isSignInMethodAllowed(none, 'entra')).toBe(false);
    expect(isSignInMethodAllowed(none, 'google')).toBe(false);

    const ssoOnly = pickEffectivePortalAccessPolicy(
      { ...blank, passwordMode: 'sso_only', entraEnabled: true, googleEnabled: true }, null, ALL_CAPS,
    );
    expect(isSignInMethodAllowed(ssoOnly, 'password')).toBe(false);
    expect(isSignInMethodAllowed(ssoOnly, 'entra')).toBe(true);
    expect(isSignInMethodAllowed(ssoOnly, 'google')).toBe(true);
  });
});

describe('capabilities', () => {
  it('W3: every capability is off by default', () => {
    expect(getPortalSignInCapabilities()).toEqual(NO_CAPS);
  });

  it('a test override applies until it is cleared, and callers cannot mutate it', () => {
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    const caps = getPortalSignInCapabilities();
    expect(caps).toEqual({ entra: true, google: false, selfRegistration: false });
    caps.google = true;
    expect(getPortalSignInCapabilities().google).toBe(false);
    __testOnly.setCapabilities(null);
    expect(getPortalSignInCapabilities()).toEqual(NO_CAPS);
  });

  it('__testOnly.setCapabilities throws outside NODE_ENV=test', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => __testOnly.setCapabilities(ALL_CAPS)).toThrow();
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => __testOnly.setCapabilities(null)).toThrow();
    vi.unstubAllEnvs();
    expect(getPortalSignInCapabilities()).toEqual(NO_CAPS);
  });
});

describe('resolvePortalAccessPolicy (mocked db)', () => {
  const policyRow = (over: Partial<Record<string, unknown>>) => ({ ...blank, orgId: null, partnerId: null, ...over });

  it('with no context held, opens a system context and reads the org then both rows', async () => {
    dbState.selectResults = [
      [{ partnerId: PARTNER_ID }],
      [
        policyRow({ partnerId: PARTNER_ID, entraEnabled: true, ssoSessionMaxHours: 24 }),
        policyRow({ orgId: ORG_ID, ssoSessionMaxHours: 4 }),
      ],
    ];
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(dbState.systemContextCalls).toBe(1);
    expect(dbState.selectResults).toHaveLength(0);
    expect(r.orgId).toBe(ORG_ID);
    expect(r.partnerId).toBe(PARTNER_ID);
    expect(r.effective.entraEnabled).toEqual({ value: true, source: 'partner' });
    expect(r.effective.ssoSessionMaxHours).toEqual({ value: 4, source: 'org' });
    expect(r.passwordModeFallback).toBe(false);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('with a context held, reads under it and never opens a system context', async () => {
    dbState.inContext = true;
    dbState.selectResults = [[{ partnerId: PARTNER_ID }], []];
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(dbState.systemContextCalls).toBe(0);
    expect(r.effective.passwordMode).toEqual({ value: 'allowed', source: 'default' });
  });

  it('throws PortalAccessPolicyOrgNotFoundError when the org row is not visible or the id is malformed', async () => {
    dbState.selectResults = [[]];
    await expect(resolvePortalAccessPolicy(ORG_ID)).rejects.toBeInstanceOf(PortalAccessPolicyOrgNotFoundError);
    await expect(resolvePortalAccessPolicy('not-a-uuid')).rejects.toBeInstanceOf(PortalAccessPolicyOrgNotFoundError);
  });
});
