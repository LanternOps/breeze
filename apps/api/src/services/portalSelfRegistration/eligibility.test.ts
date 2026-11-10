import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Portal registration W6, plan Task 3 rules 1–5 (D5–D7). The W5 read API, the
// host resolver, the tenant gate and the policy resolver are mocked at their
// boundaries; the existing-account read is captured so its WHERE can be
// rendered and checked.

const mocks = vi.hoisted(() => ({
  findOrgByVerifiedDomain: vi.fn(),
  resolvePortalHostOrgId: vi.fn(),
  getActiveOrgTenant: vi.fn(),
  resolvePortalAccessPolicy: vi.fn(),
  accountRows: { current: [] as Array<{ id: string }> },
  orgRows: { current: [] as Array<{ orgName: string; partnerName: string | null }> },
  wheres: [] as unknown[],
  selects: [] as Array<Record<string, unknown>>,
  systemCalls: { count: 0 },
}));

vi.mock('../portalDomainVerification', () => ({ findOrgByVerifiedDomain: mocks.findOrgByVerifiedDomain }));
vi.mock('../../routes/portal/branding', () => ({ resolvePortalHostOrgId: mocks.resolvePortalHostOrgId }));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: mocks.getActiveOrgTenant }));
vi.mock('../portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portalAccessPolicy')>()),
  resolvePortalAccessPolicy: mocks.resolvePortalAccessPolicy,
}));
vi.mock('../../db', () => ({
  db: {
    select: (cols: Record<string, unknown>) => {
      mocks.selects.push(cols);
      const isAccount = 'id' in cols;
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        where: (w: unknown) => { mocks.wheres.push(w); return chain; },
        limit: () => Promise.resolve(isAccount ? mocks.accountRows.current : mocks.orgRows.current),
      };
      return chain;
    },
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => { mocks.systemCalls.count += 1; return fn(); },
}));

import { emailDomainOf, resolveSelfRegistrationTarget } from './eligibility';
import { PortalAccessPolicyOrgNotFoundError } from '../portalAccessPolicy';
import { portalUsers } from '../../db/schema';

const ORG_A = '7c0a1f7e-1111-4222-8333-444455556666';
const ORG_B = '7c0a1f7e-2222-4222-8333-444455556666';
const PARTNER = '9d0a1f7e-1111-4222-8333-444455556666';
const DOMAIN = 'contoso.example.com';
const EMAIL = 'Pat@Contoso.Example.com';
const FP = 'f'.repeat(64);

const fact = (orgId = ORG_A) => ({ domain: DOMAIN, orgId, partnerId: PARTNER, method: 'dns_txt', verifiedAt: new Date() });
const policy = (mode: 'off' | 'approval' | 'instant', orgId = ORG_A) => ({
  orgId, partnerId: PARTNER, entraTenant: null, passwordModeFallback: false, fingerprint: FP,
  effective: {
    entraEnabled: { value: false, source: 'default' },
    googleEnabled: { value: false, source: 'default' },
    passwordMode: { value: 'allowed', source: 'default' },
    selfRegistrationMode: { value: mode, source: 'org' },
    ssoNewPersonMode: { value: 'approval', source: 'default' },
    ssoSessionMaxHours: { value: null, source: 'default' },
  },
});

function renderWhere(w: unknown): { sql: string; params: unknown[] } {
  const q = new QueryBuilder().select({ id: portalUsers.id }).from(portalUsers).where(w as SQL).toSQL();
  return { sql: q.sql, params: q.params };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountRows.current = [];
  mocks.orgRows.current = [{ orgName: 'Contoso', partnerName: 'Fabrikam IT' }];
  mocks.wheres.length = 0;
  mocks.selects.length = 0;
  mocks.systemCalls.count = 0;
  mocks.findOrgByVerifiedDomain.mockResolvedValue(fact());
  mocks.resolvePortalHostOrgId.mockResolvedValue(null);
  mocks.getActiveOrgTenant.mockResolvedValue({ orgId: ORG_A, partnerId: PARTNER });
  mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('approval'));
});

describe('emailDomainOf', () => {
  it('is the lower-cased text after the last @', () => {
    expect(emailDomainOf(' Pat@Contoso.Example.COM ')).toBe('contoso.example.com');
    expect(emailDomainOf('"a@b"@contoso.example.com')).toBe('contoso.example.com');
    expect(emailDomainOf('no-at-sign')).toBeNull();
    expect(emailDomainOf('trailing@')).toBeNull();
  });
});

describe('resolveSelfRegistrationTarget (W6 D5–D7)', () => {
  it('an address on a verified domain with approval mode is eligible with the policy fingerprint', async () => {
    const target = await resolveSelfRegistrationTarget({ email: EMAIL, host: null });
    expect(target).toEqual({
      kind: 'eligible', orgId: ORG_A, partnerId: PARTNER, orgName: 'Contoso', partnerName: 'Fabrikam IT',
      domain: DOMAIN, mode: 'approval', policyFingerprint: FP,
    });
    expect(mocks.findOrgByVerifiedDomain).toHaveBeenCalledTimes(1);
    expect(mocks.findOrgByVerifiedDomain).toHaveBeenCalledWith(DOMAIN);
  });

  it('instant mode is eligible with mode instant', async () => {
    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('instant'));
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: null })).toMatchObject({ kind: 'eligible', mode: 'instant' });
  });

  it('a declared-only or unknown domain is ineligible', async () => {
    // W5's read API returns null for both: a declared row is mail routing only.
    mocks.findOrgByVerifiedDomain.mockResolvedValue(null);
    expect(await resolveSelfRegistrationTarget({ email: 'pat@unknown.example.com', host: null }))
      .toEqual({ kind: 'ineligible', reason: 'no_verified_domain' });
    expect(mocks.getActiveOrgTenant).not.toHaveBeenCalled();
    expect(mocks.resolvePortalAccessPolicy).not.toHaveBeenCalled();
    expect(mocks.selects).toHaveLength(0);
  });

  it('a subdomain of a verified domain is ineligible', async () => {
    mocks.findOrgByVerifiedDomain.mockImplementation(async (d: string) => (d === DOMAIN ? fact() : null));
    expect(await resolveSelfRegistrationTarget({ email: 'pat@eu.contoso.example.com', host: null }))
      .toEqual({ kind: 'ineligible', reason: 'no_verified_domain' });
    expect(mocks.findOrgByVerifiedDomain).toHaveBeenCalledWith('eu.contoso.example.com');
  });

  it('an address with no domain is ineligible without a lookup', async () => {
    expect(await resolveSelfRegistrationTarget({ email: 'nodomain@', host: null }))
      .toEqual({ kind: 'ineligible', reason: 'no_verified_domain' });
    expect(mocks.findOrgByVerifiedDomain).not.toHaveBeenCalled();
  });

  it('mode off, an inactive org and a host mismatch are ineligible', async () => {
    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('off'));
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: null })).toEqual({ kind: 'ineligible', reason: 'mode_off' });

    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('approval'));
    mocks.getActiveOrgTenant.mockResolvedValue(null);
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: null })).toEqual({ kind: 'ineligible', reason: 'org_inactive' });

    mocks.getActiveOrgTenant.mockResolvedValue({ orgId: ORG_A, partnerId: PARTNER });
    mocks.resolvePortalAccessPolicy.mockRejectedValue(new PortalAccessPolicyOrgNotFoundError(ORG_A));
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: null })).toEqual({ kind: 'ineligible', reason: 'org_inactive' });

    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('approval'));
    mocks.resolvePortalHostOrgId.mockResolvedValue(ORG_B);
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: 'portal.other.example.com' }))
      .toEqual({ kind: 'ineligible', reason: 'host_mismatch' });
  });

  it('a custom-domain host for org X never yields org Y\'s link', async () => {
    // Address on org A's verified domain, request on org B's custom portal host.
    mocks.resolvePortalHostOrgId.mockImplementation(async (h: string) => (h === 'portal.orgb.example.com' ? ORG_B : null));
    const target = await resolveSelfRegistrationTarget({ email: EMAIL, host: 'portal.orgb.example.com' });
    expect(target).toEqual({ kind: 'ineligible', reason: 'host_mismatch' });
    // Nothing about org A is read past the binding.
    expect(mocks.resolvePortalAccessPolicy).not.toHaveBeenCalled();
    expect(mocks.selects).toHaveLength(0);
  });

  it('a host that is org A\'s own custom domain, or the shared host, applies no extra refusal', async () => {
    mocks.resolvePortalHostOrgId.mockResolvedValue(ORG_A);
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: 'portal.contoso.example.com' })).toMatchObject({ kind: 'eligible', orgId: ORG_A });
    mocks.resolvePortalHostOrgId.mockResolvedValue(null);
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: 'portal.shared.example.com' })).toMatchObject({ kind: 'eligible', orgId: ORG_A });
    expect(mocks.resolvePortalHostOrgId).toHaveBeenCalledWith('portal.shared.example.com');
  });

  it('a null host never calls the host resolver', async () => {
    await resolveSelfRegistrationTarget({ email: EMAIL, host: null });
    expect(mocks.resolvePortalHostOrgId).not.toHaveBeenCalled();
  });

  it('an account at the same address in another org does not count as existing', async () => {
    // The existing-account read is scoped to the matched org: render its WHERE.
    await resolveSelfRegistrationTarget({ email: EMAIL, host: null });
    const accountWhere = mocks.wheres[mocks.selects.findIndex((s) => 'id' in s)];
    const { sql, params } = renderWhere(accountWhere);
    expect(sql).toMatch(/"portal_users"\."org_id" = \$1/);
    expect(params).toContain(ORG_A);
    expect(params).toContain('pat@contoso.example.com');
    expect(params).not.toContain(ORG_B);
  });

  it('any status of account in the matched org counts as existing (invited, active, disabled, add-in)', async () => {
    mocks.accountRows.current = [{ id: 'u-1' }];
    const target = await resolveSelfRegistrationTarget({ email: EMAIL, host: null });
    expect(target).toEqual({
      kind: 'existing_account', orgId: ORG_A, partnerId: PARTNER, orgName: 'Contoso', partnerName: 'Fabrikam IT', domain: DOMAIN, mode: 'approval',
    });
    // The read has no status / browser_access / auth_method filter.
    const accountWhere = mocks.wheres[mocks.selects.findIndex((s) => 'id' in s)];
    const { sql } = renderWhere(accountWhere);
    expect(sql).not.toMatch(/status|browser_access|auth_method/);
  });

  it('a domain cleared before the job runs sends nothing', async () => {
    // Verified at submit time is irrelevant: the worker re-reads W5 now.
    mocks.findOrgByVerifiedDomain.mockResolvedValue(null);
    expect(await resolveSelfRegistrationTarget({ email: EMAIL, host: null })).toEqual({ kind: 'ineligible', reason: 'no_verified_domain' });
  });

  it('runs every DB read in a system context of its own', async () => {
    await resolveSelfRegistrationTarget({ email: EMAIL, host: null });
    expect(mocks.systemCalls.count).toBeGreaterThanOrEqual(1);
  });
});
