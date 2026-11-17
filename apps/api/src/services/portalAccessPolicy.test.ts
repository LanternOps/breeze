import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalAccessPolicyRowValues, PortalSignInCapabilities } from '@breeze/shared';

const dbState = vi.hoisted(() => ({
  inContext: false,
  /** The held context's scope when `inContext` (W7: decides runOutsideDbContext for the W5 read). */
  heldScope: 'organization' as 'system' | 'organization' | 'partner',
  outsideCalls: 0,
  selectResults: [] as unknown[][],
  systemContextCalls: 0,
  /** The builder methods each select chain was given, in order (one entry per db.select). */
  chains: [] as string[][],
}));

const selfReg = vi.hoisted(() => ({ available: false }));

// W7 (#11384): W5's read API, as the resolver sees it. Records whether a DB context was held at the call.
const domains = vi.hoisted(() => ({
  list: [] as Array<{ domain: string; orgId: string }>,
  error: null as Error | null,
  calls: [] as Array<{ orgId: string; inContext: boolean }>,
}));
vi.mock('./portalDomainVerification', () => ({
  listVerifiedDomainsForOrg: vi.fn(async (orgId: string) => {
    domains.calls.push({ orgId, inContext: dbState.inContext });
    if (domains.error) throw domains.error;
    return domains.list.map((d) => ({ ...d, partnerId: 'p', method: 'dns_txt', verifiedAt: new Date() }));
  }),
}));
vi.mock('../config/portalSelfRegistration', () => ({
  isPortalSelfRegistrationAvailable: () => selfReg.available,
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
    getCurrentDbAccessContext: () => (dbState.inContext ? { scope: dbState.heldScope } : undefined),
    runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => {
      dbState.outsideCalls += 1;
      const held = dbState.inContext;
      dbState.inContext = false;
      try {
        return fn();
      } finally {
        dbState.inContext = held;
      }
    }),
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
/** W3 semantics (no tenant gate): the org's Entra tenant is proven (and, W7, it has a verified domain). */
const PROVEN: PortalPolicyOrgFacts = { entraTenantProven: true, googleDomainVerified: true };
const UNPROVEN: PortalPolicyOrgFacts = { entraTenantProven: false, googleDomainVerified: true };

const ORG_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const PARTNER_ID = '9f8e7d6c-5b4a-4f3e-9d2c-1b0a9f8e7d6c';
const TENANT_A = 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5';
const TENANT_B = 'b2b2b2b2-c3c3-4d4d-9e5e-f6f6f6f6f6f6';
const PROVEN_AT = new Date('2027-01-23T10:00:00.000Z');

beforeEach(() => {
  selfReg.available = false;
  dbState.inContext = false;
  dbState.heldScope = 'organization';
  dbState.outsideCalls = 0;
  domains.list = [];
  domains.error = null;
  domains.calls = [];
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

  it('selfRegistration capability is isPortalSelfRegistrationAvailable()', () => {
    // W06b Task 10: the kill switch AND an email service, read at call time.
    selfReg.available = true;
    expect(getPortalSignInCapabilities()).toEqual({ entra: false, google: false, selfRegistration: true });
    selfReg.available = false;
    expect(getPortalSignInCapabilities().selfRegistration).toBe(false);
  });

  it('effective selfRegistrationMode is off while the capability is off, whatever the rows say', () => {
    const org = { ...blank, selfRegistrationMode: 'instant' as const };
    const partner = { ...blank, selfRegistrationMode: 'approval' as const };
    selfReg.available = false;
    expect(pickEffectivePortalAccessPolicy(org, partner, getPortalSignInCapabilities(), PROVEN).effective.selfRegistrationMode.value).toBe('off');
    expect(pickEffectivePortalAccessPolicy(blank, partner, getPortalSignInCapabilities(), PROVEN).effective.selfRegistrationMode.value).toBe('off');
    selfReg.available = true;
    expect(pickEffectivePortalAccessPolicy(org, partner, getPortalSignInCapabilities(), PROVEN).effective.selfRegistrationMode.value).toBe('instant');
    expect(pickEffectivePortalAccessPolicy(blank, partner, getPortalSignInCapabilities(), PROVEN).effective.selfRegistrationMode.value).toBe('approval');
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

// ---------------------------------------------------------------------------
// W7 (#11384): Google capability and the verified-domain mask (plan D6, D11)
// ---------------------------------------------------------------------------

const GOOGLE_CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const GOOGLE_ONLY: PortalSignInCapabilities = { entra: false, google: true, selfRegistration: false };
const NO_DOMAIN: PortalPolicyOrgFacts = { entraTenantProven: true, googleDomainVerified: false };

describe('W7: Google capability', () => {
  beforeEach(() => {
    for (const name of ['PORTAL_ENTRA_CLIENT_ID', 'PORTAL_ENTRA_CLIENT_SECRET', 'PORTAL_GOOGLE_CLIENT_ID', 'PORTAL_GOOGLE_CLIENT_SECRET']) {
      vi.stubEnv(name, '');
    }
  });

  it('getPortalSignInCapabilities().google follows the portal Google config', () => {
    expect(getPortalSignInCapabilities().google).toBe(false);
    vi.stubEnv('PORTAL_GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID);
    expect(getPortalSignInCapabilities().google).toBe(false);
    vi.stubEnv('PORTAL_GOOGLE_CLIENT_SECRET', 'portal-google-secret');
    expect(getPortalSignInCapabilities()).toEqual({ entra: false, google: true, selfRegistration: false });
    // Either one blank: off again, read at call time.
    vi.stubEnv('PORTAL_GOOGLE_CLIENT_ID', '  ');
    expect(getPortalSignInCapabilities().google).toBe(false);
    // The test override keeps precedence.
    vi.stubEnv('PORTAL_GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID);
    __testOnly.setCapabilities(NO_CAPS);
    expect(getPortalSignInCapabilities().google).toBe(false);
  });

  it('ships dark: with PORTAL_GOOGLE_* unset, google is off and a stored googleEnabled true resolves false without any domain read', async () => {
    expect(getPortalSignInCapabilities().google).toBe(false);
    dbState.selectResults = [
      [{ partnerId: PARTNER_ID, entraTenantId: null, entraTenantProvenAt: null }],
      [{ ...blank, orgId: ORG_ID, partnerId: null, googleEnabled: true, passwordMode: 'sso_only' }],
    ];
    domains.list = [{ domain: 'contoso.example.com', orgId: ORG_ID }];
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(r.effective.googleEnabled).toEqual({ value: false, source: 'org' });
    expect(isSignInMethodAllowed(r, 'google')).toBe(false);
    // Existing sign-in paths are untouched: password stays allowed (sso_only has no SSO method to hold it).
    expect(r.effective.passwordMode.value).toBe('allowed');
    expect(isSignInMethodAllowed(r, 'password')).toBe(true);
    expect(r.googleDomains).toBeNull();
    expect(domains.calls).toEqual([]);
  });
});

describe('W7: pickEffectivePortalAccessPolicy domain mask', () => {
  it('googleEnabled is masked off when the org has no verified domain (source stays org)', () => {
    const org = { ...blank, googleEnabled: true };
    expect(pickEffectivePortalAccessPolicy(org, null, GOOGLE_ONLY, NO_DOMAIN).effective.googleEnabled)
      .toEqual({ value: false, source: 'org' });
    expect(pickEffectivePortalAccessPolicy(null, org, GOOGLE_ONLY, NO_DOMAIN).effective.googleEnabled)
      .toEqual({ value: false, source: 'partner' });
    expect(pickEffectivePortalAccessPolicy(org, null, GOOGLE_ONLY, PROVEN).effective.googleEnabled)
      .toEqual({ value: true, source: 'org' });
    // Capability mask first: a verified domain cannot turn Google on where the deployment cannot run it.
    expect(pickEffectivePortalAccessPolicy(org, null, NO_CAPS, PROVEN).effective.googleEnabled)
      .toEqual({ value: false, source: 'org' });
    // The domain mask touches only Google.
    const both = pickEffectivePortalAccessPolicy({ ...org, entraEnabled: true }, null, ALL_CAPS, NO_DOMAIN);
    expect(both.effective.entraEnabled).toEqual({ value: true, source: 'org' });
  });

  it('sso_only with Google the only SSO method falls back to allowed without a verified domain', () => {
    const org = { ...blank, passwordMode: 'sso_only' as const, googleEnabled: true };
    const verified = pickEffectivePortalAccessPolicy(org, null, GOOGLE_ONLY, PROVEN);
    expect(verified.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    const lapsed = pickEffectivePortalAccessPolicy(org, null, GOOGLE_ONLY, NO_DOMAIN);
    expect(lapsed.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(lapsed.passwordModeFallback).toBe(true);
  });
});

describe('W7: resolvePortalAccessPolicy verified-domain read (mocked db + W5)', () => {
  const orgRead = [{ partnerId: PARTNER_ID, entraTenantId: null, entraTenantProvenAt: null }];
  const googleRow = (over: Partial<Record<string, unknown>> = {}) => [{ ...blank, orgId: ORG_ID, partnerId: null, googleEnabled: true, ...over }];

  beforeEach(() => {
    __testOnly.setCapabilities(GOOGLE_ONLY);
  });

  it('googleEnabled is masked off when the org has no verified domain (source stays org)', async () => {
    dbState.selectResults = [orgRead, googleRow()];
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(r.effective.googleEnabled).toEqual({ value: false, source: 'org' });
    expect(r.googleDomains).toEqual([]);
    expect(isSignInMethodAllowed(r, 'google')).toBe(false);
  });

  it('sso_only falls back to allowed when the last verified domain lapses and Google was the only SSO method', async () => {
    const rows = googleRow({ passwordMode: 'sso_only' });
    domains.list = [{ domain: 'contoso.example.com', orgId: ORG_ID }];
    dbState.selectResults = [orgRead, rows];
    const before = await resolvePortalAccessPolicy(ORG_ID);
    expect(before.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(isSignInMethodAllowed(before, 'google')).toBe(true);
    expect(isSignInMethodAllowed(before, 'password')).toBe(false);

    domains.list = [];
    dbState.selectResults = [orgRead, rows];
    const after = await resolvePortalAccessPolicy(ORG_ID);
    expect(after.effective.googleEnabled).toEqual({ value: false, source: 'org' });
    expect(after.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(after.passwordModeFallback).toBe(true);
    expect(isSignInMethodAllowed(after, 'password')).toBe(true);
    // The fingerprint follows the effective change (W6 tokens die with it).
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('the verified-domain read is skipped when the picked googleEnabled is false (read API mock not called)', async () => {
    dbState.selectResults = [orgRead, googleRow({ googleEnabled: false })];
    expect((await resolvePortalAccessPolicy(ORG_ID)).googleDomains).toBeNull();
    dbState.selectResults = [orgRead, []];
    expect((await resolvePortalAccessPolicy(ORG_ID)).googleDomains).toBeNull();
    // Picked on, but the deployment cannot run Google: still no read.
    __testOnly.setCapabilities(NO_CAPS);
    dbState.selectResults = [orgRead, googleRow()];
    expect((await resolvePortalAccessPolicy(ORG_ID)).googleDomains).toBeNull();
    expect(domains.calls).toEqual([]);
    // An inherited partner true is a picked true: read.
    __testOnly.setCapabilities(GOOGLE_ONLY);
    dbState.selectResults = [orgRead, [{ ...blank, orgId: null, partnerId: PARTNER_ID, googleEnabled: true }]];
    await resolvePortalAccessPolicy(ORG_ID);
    expect(domains.calls).toHaveLength(1);
  });

  it('googleDomains lists the verified domains lowercase and sorted; null when not read', async () => {
    domains.list = [
      { domain: 'Zeta.Example.com', orgId: ORG_ID },
      { domain: 'alpha.example.com', orgId: ORG_ID },
      { domain: 'contoso.example.com', orgId: ORG_ID },
    ];
    dbState.selectResults = [orgRead, googleRow()];
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(r.googleDomains).toEqual(['alpha.example.com', 'contoso.example.com', 'zeta.example.com']);
    expect(r.effective.googleEnabled).toEqual({ value: true, source: 'org' });
    expect(domains.calls).toEqual([{ orgId: ORG_ID, inContext: false }]);
  });

  it('under a held request context the read goes through runOutsideDbContext', async () => {
    domains.list = [{ domain: 'contoso.example.com', orgId: ORG_ID }];
    dbState.inContext = true;
    dbState.heldScope = 'organization';
    dbState.selectResults = [orgRead, googleRow()];
    const r = await resolvePortalAccessPolicy(ORG_ID);
    expect(dbState.outsideCalls).toBe(1);
    expect(domains.calls).toEqual([{ orgId: ORG_ID, inContext: false }]);
    expect(r.effective.googleEnabled.value).toBe(true);
    // A held SYSTEM context reads under it (W5's inSystemContext accepts one).
    dbState.heldScope = 'system';
    dbState.selectResults = [orgRead, googleRow()];
    await resolvePortalAccessPolicy(ORG_ID);
    expect(dbState.outsideCalls).toBe(1);
    expect(domains.calls[1]).toEqual({ orgId: ORG_ID, inContext: true });
  });

  it('a W5 read that throws propagates; it never masks Google off or re-allows passwords', async () => {
    domains.error = new Error('evidence read failed');
    dbState.selectResults = [orgRead, googleRow({ passwordMode: 'sso_only' })];
    await expect(resolvePortalAccessPolicy(ORG_ID)).rejects.toThrow('evidence read failed');
  });
});
