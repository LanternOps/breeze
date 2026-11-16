import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalAccessPolicyRowValues, PortalSignInCapabilities } from '@breeze/shared';

/**
 * W7 (#11384, plan D6): the password-fallback impact (#11582) is a caller of
 * pickEffectivePortalAccessPolicy, so it carries the org's real Google
 * verified-domain fact. Only the Entra proof differs between its two picks, so
 * a fallback the Google domain mask causes on its own is never reported as a
 * lost Microsoft tenant.
 */

const h = vi.hoisted(() => ({
  rows: { org: null as PortalAccessPolicyRowValues | null, partner: null as PortalAccessPolicyRowValues | null },
  domains: [] as string[],
  domainError: null as Error | null,
  domainCalls: [] as string[],
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }) }) }),
  },
  hasDbAccessContext: () => false,
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  runAfterDbContextCommit: () => {},
}));

vi.mock('./portalAccessPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portalAccessPolicy')>();
  return {
    ...actual,
    readPortalAccessPolicyRows: vi.fn(async () => h.rows),
    listOrgVerifiedDomains: vi.fn(async (orgId: string) => {
      h.domainCalls.push(orgId);
      if (h.domainError) throw h.domainError;
      return h.domains;
    }),
  };
});

import { __testOnly } from './portalAccessPolicy';
import { getPortalPasswordFallbackImpact, passwordFallbackImpactFrom } from './portalPasswordFallback';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const ALL_CAPS: PortalSignInCapabilities = { entra: true, google: true, selfRegistration: false };
const ENTRA_ONLY: PortalSignInCapabilities = { entra: true, google: false, selfRegistration: false };
const row = (over: Partial<PortalAccessPolicyRowValues> = {}): PortalAccessPolicyRowValues => ({
  entraEnabled: null, googleEnabled: null, passwordMode: null,
  selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null, ...over,
});

beforeEach(() => {
  h.rows = { org: null, partner: null };
  h.domains = [];
  h.domainError = null;
  h.domainCalls = [];
});
afterEach(() => __testOnly.setCapabilities(null));

describe('passwordFallbackImpactFrom with the Google domain fact', () => {
  it('Google-only sso_only whose domain lapsed is NOT an Entra-tenant fallback (null)', () => {
    const rows = { org: row({ googleEnabled: true, passwordMode: 'sso_only' }), partner: null };
    expect(passwordFallbackImpactFrom(rows, ALL_CAPS, { googleDomainVerified: false })).toBeNull();
    expect(passwordFallbackImpactFrom(rows, ALL_CAPS, { googleDomainVerified: true })).toBeNull();
  });

  it('Microsoft + Google with sso_only: Google holds password off only while a domain is verified', () => {
    const rows = { org: row({ entraEnabled: true, googleEnabled: true, passwordMode: 'sso_only' }), partner: null };
    expect(passwordFallbackImpactFrom(rows, ALL_CAPS, { googleDomainVerified: true })).toEqual({ passwordModeFallback: false });
    // Google was already masked (no domain): it is losing the proof that brings passwords back.
    expect(passwordFallbackImpactFrom(rows, ALL_CAPS, { googleDomainVerified: false })).toEqual({ passwordModeFallback: true });
  });

  it('an org with Google off: the outcome does not depend on the Google fact', () => {
    for (const rows of [
      { org: row({ entraEnabled: true, passwordMode: 'sso_only' }), partner: null },
      { org: null, partner: row({ entraEnabled: true }) },
      { org: row({ entraEnabled: true, googleEnabled: false, passwordMode: 'sso_only' }), partner: row({ googleEnabled: true }) },
    ]) {
      expect(passwordFallbackImpactFrom(rows, ALL_CAPS, { googleDomainVerified: false }))
        .toEqual(passwordFallbackImpactFrom(rows, ALL_CAPS, { googleDomainVerified: true }));
    }
  });
});

describe('getPortalPasswordFallbackImpact reads the Google fact under the resolver guard', () => {
  it('reads the verified domains only when the picked Google is on and the deployment can run it', async () => {
    __testOnly.setCapabilities(ENTRA_ONLY);
    h.rows = { org: row({ entraEnabled: true, googleEnabled: true, passwordMode: 'sso_only' }), partner: null };
    expect(await getPortalPasswordFallbackImpact(ORG_ID)).toEqual({ passwordModeFallback: true });
    expect(h.domainCalls).toEqual([]);

    __testOnly.setCapabilities(ALL_CAPS);
    h.rows = { org: row({ entraEnabled: true, passwordMode: 'sso_only' }), partner: null };
    expect(await getPortalPasswordFallbackImpact(ORG_ID)).toEqual({ passwordModeFallback: true });
    expect(h.domainCalls).toEqual([]);
  });

  it('uses the real fact: a verified domain keeps Google holding sso_only; none brings passwords back', async () => {
    __testOnly.setCapabilities(ALL_CAPS);
    h.rows = { org: row({ entraEnabled: true, googleEnabled: true, passwordMode: 'sso_only' }), partner: null };
    h.domains = ['contoso.example.com'];
    expect(await getPortalPasswordFallbackImpact(ORG_ID)).toEqual({ passwordModeFallback: false });
    h.domains = [];
    expect(await getPortalPasswordFallbackImpact(ORG_ID)).toEqual({ passwordModeFallback: true });
    expect(h.domainCalls).toEqual([ORG_ID, ORG_ID]);
  });

  it('a Google-only org never yields an impact, so no Entra-tenant notice or audit is raised for it', async () => {
    __testOnly.setCapabilities(ALL_CAPS);
    h.rows = { org: row({ googleEnabled: true, passwordMode: 'sso_only' }), partner: null };
    h.domains = [];
    expect(await getPortalPasswordFallbackImpact(ORG_ID)).toBeNull();
  });

  it('a W5 read failure propagates (fail closed, never "no domain")', async () => {
    __testOnly.setCapabilities(ALL_CAPS);
    h.rows = { org: row({ entraEnabled: true, googleEnabled: true, passwordMode: 'sso_only' }), partner: null };
    h.domainError = new Error('evidence read failed');
    await expect(getPortalPasswordFallbackImpact(ORG_ID)).rejects.toThrow('evidence read failed');
  });
});
