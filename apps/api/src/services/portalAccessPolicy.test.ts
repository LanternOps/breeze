import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalAccessPolicyRowValues, PortalSignInCapabilities } from '@breeze/shared';

const dbState = vi.hoisted(() => ({
  inContext: false,
  selectResults: [] as unknown[][],
  systemContextCalls: 0,
  /** The builder methods each select chain was given, in order (one entry per db.select). */
  chains: [] as string[][],
}));

vi.mock('../db', () => {
  const nextChain = () => {
    const result = dbState.selectResults.shift() ?? [];
    const calls: string[] = [];
    dbState.chains.push(calls);
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'where', 'limit']) chain[m] = () => { calls.push(m); return chain; };
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
  type PortalPolicyOrgFacts,
} from './portalAccessPolicy';

const blank: PortalAccessPolicyRowValues = {
  entraEnabled: null, googleEnabled: null, passwordMode: null,
  selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null,
};
const NO_CAPS: PortalSignInCapabilities = { entra: false, google: false, selfRegistration: false };
const ALL_CAPS: PortalSignInCapabilities = { entra: true, google: true, selfRegistration: true };
/** W3 semantics (no tenant gate): the org's Entra tenant is proven. */
const PROVEN: PortalPolicyOrgFacts = { entraTenantProven: true };
const UNPROVEN: PortalPolicyOrgFacts = { entraTenantProven: false };

const ORG_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const PARTNER_ID = '9f8e7d6c-5b4a-4f3e-9d2c-1b0a9f8e7d6c';
const TENANT_A = 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5';
const TENANT_B = 'b2b2b2b2-c3c3-4d4d-9e5e-f6f6f6f6f6f6';
const PROVEN_AT = new Date('2027-01-23T10:00:00.000Z');

beforeEach(() => {
  dbState.inContext = false;
  dbState.selectResults = [];
  dbState.systemContextCalls = 0;
  dbState.chains = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  __testOnly.setCapabilities(null);
});

describe('pickEffectivePortalAccessPolicy', () => {
  it('defaults when neither row exists: password allowed, sso approval, 12 h, everything else off', () => {
    const r = pickEffectivePortalAccessPolicy(null, null, ALL_CAPS, PROVEN);
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
    expect(pickEffectivePortalAccessPolicy(blank, blank, ALL_CAPS, PROVEN).effective).toEqual(r.effective);
  });

  it('org false beats partner true; org null inherits partner; partner null falls to default (source per field)', () => {
    const partner = { ...blank, entraEnabled: true, googleEnabled: true, ssoNewPersonMode: 'instant' as const, ssoSessionMaxHours: 24 };
    const org = { ...blank, entraEnabled: false, ssoSessionMaxHours: 8 };
    const r = pickEffectivePortalAccessPolicy(org, partner, ALL_CAPS, PROVEN);
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
    const masked = pickEffectivePortalAccessPolicy(org, partner, NO_CAPS, PROVEN);
    expect(masked.effective.entraEnabled).toEqual({ value: false, source: 'org' });
    expect(masked.effective.googleEnabled).toEqual({ value: false, source: 'partner' });
    expect(masked.effective.selfRegistrationMode).toEqual({ value: 'off', source: 'org' });

    const open = pickEffectivePortalAccessPolicy(org, partner, ALL_CAPS, PROVEN);
    expect(open.effective.entraEnabled).toEqual({ value: true, source: 'org' });
    expect(open.effective.googleEnabled).toEqual({ value: true, source: 'partner' });
    expect(open.effective.selfRegistrationMode).toEqual({ value: 'instant', source: 'org' });
  });

  it('sso_only with no effective SSO method falls back to allowed and reports passwordModeFallback', () => {
    // Review Focus 4: the org says sso_only; the partner turned its (inherited) entra off.
    const org = { ...blank, passwordMode: 'sso_only' as const };
    const partner = { ...blank, entraEnabled: false };
    const r = pickEffectivePortalAccessPolicy(org, partner, ALL_CAPS, PROVEN);
    expect(r.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(r.passwordModeFallback).toBe(true);

    // Entra on in the row but the deployment cannot run it: masked off, so the fallback still applies.
    const masked = pickEffectivePortalAccessPolicy({ ...org, entraEnabled: true }, null, NO_CAPS, PROVEN);
    expect(masked.effective.passwordMode.value).toBe('allowed');
    expect(masked.passwordModeFallback).toBe(true);
  });

  it('sso_only with entra on and caps.entra stays sso_only', () => {
    const r = pickEffectivePortalAccessPolicy(
      { ...blank, passwordMode: 'sso_only' }, { ...blank, entraEnabled: true },
      { entra: true, google: false, selfRegistration: false }, PROVEN,
    );
    expect(r.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(r.passwordModeFallback).toBe(false);

    const viaGoogle = pickEffectivePortalAccessPolicy(
      null, { ...blank, passwordMode: 'sso_only', googleEnabled: true },
      { entra: false, google: true, selfRegistration: false }, PROVEN,
    );
    expect(viaGoogle.effective.passwordMode).toEqual({ value: 'sso_only', source: 'partner' });
    expect(viaGoogle.passwordModeFallback).toBe(false);
  });

  it('fingerprint changes when an effective value changes and not when only a masked raw value changes', () => {
    const base = pickEffectivePortalAccessPolicy(null, null, NO_CAPS, PROVEN).fingerprint;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic.
    expect(pickEffectivePortalAccessPolicy(null, null, NO_CAPS, PROVEN).fingerprint).toBe(base);
    // A masked raw value (entra on, but no capability) leaves every effective value unchanged.
    expect(pickEffectivePortalAccessPolicy({ ...blank, entraEnabled: true }, null, NO_CAPS, PROVEN).fingerprint).toBe(base);
    // A source-only change (org now states the default explicitly) is not a policy change either.
    expect(pickEffectivePortalAccessPolicy({ ...blank, ssoSessionMaxHours: 12 }, null, NO_CAPS, PROVEN).fingerprint).toBe(base);
    // A real effective change moves it.
    expect(pickEffectivePortalAccessPolicy({ ...blank, ssoSessionMaxHours: 13 }, null, NO_CAPS, PROVEN).fingerprint).not.toBe(base);
    expect(pickEffectivePortalAccessPolicy({ ...blank, entraEnabled: true }, null, { ...NO_CAPS, entra: true }, PROVEN).fingerprint)
      .not.toBe(base);
  });

  it('isSignInMethodAllowed maps password/entra/google to the effective fields', () => {
    const none = pickEffectivePortalAccessPolicy(null, null, ALL_CAPS, PROVEN);
    expect(isSignInMethodAllowed(none, 'password')).toBe(true);
    expect(isSignInMethodAllowed(none, 'entra')).toBe(false);
    expect(isSignInMethodAllowed(none, 'google')).toBe(false);

    const ssoOnly = pickEffectivePortalAccessPolicy(
      { ...blank, passwordMode: 'sso_only', entraEnabled: true, googleEnabled: true }, null, ALL_CAPS, PROVEN,
    );
    expect(isSignInMethodAllowed(ssoOnly, 'password')).toBe(false);
    expect(isSignInMethodAllowed(ssoOnly, 'entra')).toBe(true);
    expect(isSignInMethodAllowed(ssoOnly, 'google')).toBe(true);
  });

  // W4 (#11381) D2: Microsoft is masked for an org without a proven Entra tenant.
  it('entra on (org row) but no proven tenant → effective false with source org', () => {
    const org = { ...blank, entraEnabled: true };
    const unproven = pickEffectivePortalAccessPolicy(org, null, ALL_CAPS, UNPROVEN);
    expect(unproven.effective.entraEnabled).toEqual({ value: false, source: 'org' });
    expect(isSignInMethodAllowed(unproven, 'entra')).toBe(false);
    // Inherited from the partner: masked the same way, source kept.
    const inherited = pickEffectivePortalAccessPolicy(null, org, ALL_CAPS, UNPROVEN);
    expect(inherited.effective.entraEnabled).toEqual({ value: false, source: 'partner' });
    // The tenant mask touches only Microsoft.
    const google = pickEffectivePortalAccessPolicy({ ...org, googleEnabled: true }, null, ALL_CAPS, UNPROVEN);
    expect(google.effective.googleEnabled).toEqual({ value: true, source: 'org' });
    // Proven: on. Proven but the deployment cannot run it: still off (capability mask first).
    expect(pickEffectivePortalAccessPolicy(org, null, ALL_CAPS, PROVEN).effective.entraEnabled)
      .toEqual({ value: true, source: 'org' });
    expect(pickEffectivePortalAccessPolicy(org, null, NO_CAPS, PROVEN).effective.entraEnabled)
      .toEqual({ value: false, source: 'org' });
  });

  it('sso_only with entra the only SSO method falls back to allowed when the tenant is unproven', () => {
    const org = { ...blank, passwordMode: 'sso_only' as const, entraEnabled: true };
    const proven = pickEffectivePortalAccessPolicy(org, null, ALL_CAPS, PROVEN);
    expect(proven.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(proven.passwordModeFallback).toBe(false);
    const unproven = pickEffectivePortalAccessPolicy(org, null, ALL_CAPS, UNPROVEN);
    expect(unproven.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(unproven.passwordModeFallback).toBe(true);
    expect(isSignInMethodAllowed(unproven, 'password')).toBe(true);
    // Google still on: sso_only holds without Microsoft.
    const withGoogle = pickEffectivePortalAccessPolicy({ ...org, googleEnabled: true }, null, ALL_CAPS, UNPROVEN);
    expect(withGoogle.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
  });
});

const PORTAL_APP_ID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

describe('capabilities', () => {
  beforeEach(() => {
    // The portal Entra app is not configured unless a case says so.
    vi.stubEnv('PORTAL_ENTRA_CLIENT_ID', '');
    vi.stubEnv('PORTAL_ENTRA_CLIENT_SECRET', '');
  });

  it('every capability is off when the portal Entra app is not configured', () => {
    expect(getPortalSignInCapabilities()).toEqual(NO_CAPS);
  });

  it('getPortalSignInCapabilities().entra follows the portal Entra config', () => {
    // Both id and secret set: Microsoft can run. Google and self-registration are other waves'.
    vi.stubEnv('PORTAL_ENTRA_CLIENT_ID', PORTAL_APP_ID);
    vi.stubEnv('PORTAL_ENTRA_CLIENT_SECRET', 'portal-app-secret');
    expect(getPortalSignInCapabilities()).toEqual({ entra: true, google: false, selfRegistration: false });

    // Either one missing: off. Read at call time, so no restart is needed.
    vi.stubEnv('PORTAL_ENTRA_CLIENT_SECRET', '');
    expect(getPortalSignInCapabilities().entra).toBe(false);
    vi.stubEnv('PORTAL_ENTRA_CLIENT_SECRET', 'portal-app-secret');
    vi.stubEnv('PORTAL_ENTRA_CLIENT_ID', '  ');
    expect(getPortalSignInCapabilities().entra).toBe(false);

    // The test override keeps precedence over the env, both ways.
    vi.stubEnv('PORTAL_ENTRA_CLIENT_ID', PORTAL_APP_ID);
    __testOnly.setCapabilities(NO_CAPS);
    expect(getPortalSignInCapabilities().entra).toBe(false);
    __testOnly.setCapabilities(null);
    expect(getPortalSignInCapabilities().entra).toBe(true);
  });

  it('unconfigured production with no public URL reads as off and never throws', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const name of ['PORTAL_ENTRA_CALLBACK_BASE_URL', 'PUBLIC_URL', 'PUBLIC_APP_URL', 'PUBLIC_API_URL']) vi.stubEnv(name, '');
    expect(() => getPortalSignInCapabilities()).not.toThrow();
    expect(getPortalSignInCapabilities().entra).toBe(false);
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
    // Neither refused call left an override behind.
    vi.stubEnv('NODE_ENV', 'test');
    expect(getPortalSignInCapabilities()).toEqual(NO_CAPS);
  });
});

describe('resolvePortalAccessPolicy (mocked db)', () => {
  const policyRow = (over: Partial<Record<string, unknown>>) => ({ ...blank, orgId: null, partnerId: null, ...over });

  it('with no context held, opens a system context and reads the org then both rows', async () => {
    dbState.selectResults = [
      [{ partnerId: PARTNER_ID, entraTenantId: TENANT_A, entraTenantProvenAt: PROVEN_AT }],
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

  // W4 (#11381) D2: the proven tenant rides on the resolver's existing organizations read.
  const orgRead = (tenant: string | null) => [{
    partnerId: PARTNER_ID,
    entraTenantId: tenant,
    entraTenantProvenAt: tenant ? PROVEN_AT : null,
  }];

  it('an org with a proven tenant and NO policy rows resolves entraTenant (not hidden by the rows query)', async () => {
    dbState.selectResults = [orgRead(TENANT_A), []];
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(r.entraTenant).toEqual({ tenantId: TENANT_A, provenAt: PROVEN_AT.toISOString() });
    // No extra round trip: the mapping is LEFT JOINed onto the organizations read.
    expect(dbState.chains).toHaveLength(2);
    expect(dbState.chains[0]).toContain('leftJoin');
    expect(dbState.chains[1]).not.toContain('leftJoin');
    // No rows: everything is the default, and Microsoft stays off (the default is off).
    expect(r.effective.entraEnabled).toEqual({ value: false, source: 'default' });

    dbState.selectResults = [orgRead(null), []];
    expect((await resolvePortalAccessPolicy(ORG_ID)).entraTenant).toBeNull();
  });

  it('entra on (org row) but no proven tenant → effective false with source org (resolver)', async () => {
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    dbState.selectResults = [orgRead(null), [policyRow({ orgId: ORG_ID, entraEnabled: true })]];
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(r.effective.entraEnabled).toEqual({ value: false, source: 'org' });
    expect(r.entraTenant).toBeNull();
    expect(isSignInMethodAllowed(r, 'entra')).toBe(false);
  });

  it('sso_only falls back to allowed when the tenant proof is removed', async () => {
    // Review Focus 1: the org's override is sso_only with Microsoft its only SSO method.
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    const rows = [policyRow({ orgId: ORG_ID, entraEnabled: true, passwordMode: 'sso_only' })];
    dbState.selectResults = [orgRead(TENANT_A), rows];
    const before = await resolvePortalAccessPolicy(ORG_ID);
    expect(before.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(isSignInMethodAllowed(before, 'entra')).toBe(true);
    expect(isSignInMethodAllowed(before, 'password')).toBe(false);

    // The proof is gone (tenant repointed or displaced): nobody can sign in with Microsoft, so password comes back.
    dbState.selectResults = [orgRead(null), rows];
    const after = await resolvePortalAccessPolicy(ORG_ID);
    expect(after.entraTenant).toBeNull();
    expect(after.effective.entraEnabled).toEqual({ value: false, source: 'org' });
    expect(after.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(after.passwordModeFallback).toBe(true);
    expect(isSignInMethodAllowed(after, 'password')).toBe(true);
  });

  it('fingerprint changes when the proven tenant changes', async () => {
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    const rows = [policyRow({ partnerId: PARTNER_ID, entraEnabled: true })];
    dbState.selectResults = [orgRead(TENANT_A), rows, orgRead(TENANT_A), rows, orgRead(TENANT_B), rows];
    const a1 = await resolvePortalAccessPolicy(ORG_ID);
    const a2 = await resolvePortalAccessPolicy(ORG_ID);
    const b = await resolvePortalAccessPolicy(ORG_ID);
    expect(a2.fingerprint).toBe(a1.fingerprint);
    // Same effective values, different proven tenant: a W6 token bound to tenant A must not survive.
    expect(b.effective).toEqual(a1.effective);
    expect(b.fingerprint).not.toBe(a1.fingerprint);
    expect(b.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
