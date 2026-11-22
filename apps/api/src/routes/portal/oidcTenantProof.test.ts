/**
 * Entra tenant proof run, portal side (portal registration W4 #11381, plan
 * Task 8, D6; Review Focus 3).
 *
 * Unit level: the Graph admin-role check, the org-status read, the creator
 * membership read, the proof recorder and the audit writer are mocked at their
 * boundaries. The proof-run store and the OIDC state store (in-memory twins),
 * the Entra URL builders, the rate limiter and the portal URL builder are real,
 * so peek-vs-consume, the stored purpose and the redirects are exercised for
 * real. The real-DB end-to-end lives in
 * __tests__/integration/portalEntraTenantProof.integration.test.ts.
 */
import { createHash } from 'crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cfg: { current: null as null | { clientId: string; clientSecret: string; callbackUrl: string; consentReturnUrl: string } },
  adminCheck: vi.fn(),
  activeOrg: vi.fn(),
  record: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
  dbRows: { current: [] as unknown[] },
  perms: vi.fn(),
}));

vi.mock('../../services/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/permissions')>()),
  getUserPermissions: h.perms,
}));

vi.mock('../../config/portalEntra', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/portalEntra')>()),
  getPortalEntraConfig: () => h.cfg.current,
}));
vi.mock('../../services/ticketMailbox/microsoftIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/ticketMailbox/microsoftIdentity')>()),
  checkMailboxConsentAdminRoleViaGraph: h.adminCheck,
}));
vi.mock('../../services/tenantStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tenantStatus')>()),
  getActiveOrgTenant: h.activeOrg,
}));
vi.mock('../../services/portalEntraTenantProof', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalEntraTenantProof')>()),
  recordEntraTenantProof: h.record,
}));
vi.mock('../../services/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sentry')>()),
  captureException: h.capture,
}));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: h.audit,
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin']) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.dbRows.current).then(resolve);
  return {
    db: chain,
    hasDbAccessContext: () => false,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withDbAccessContext: async <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    withDbTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

import {
  PORTAL_ENTRA_PROOF_ROUTE,
  entraSetupResult,
  handleTenantProofCallback,
  startPortalEntraTenantProof,
  type PortalTenantProofCallbackInput,
} from './oidcTenantProof';
import { portalEntraProofRuns, portalOidcStates, portalRateLimitBuckets } from './helpers';
import { PORTAL_ENTRA_PROOF_RUN_PATH, createPortalEntraProofRun, peekPortalEntraProofRun } from '../../services/portalOidc/proofRunStore';
import { PortalEntraProofError } from '../../services/portalEntraTenantProof';
import { entraIssuer } from '../../services/portalUserIdentities';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const PARTNER = '3b0a1f7e-1111-4222-8333-444455556666';
const CREATOR = '11111111-2222-4333-8444-555566667777';
const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER_TENANT = '22222222-3333-4444-8555-666666666666';
const ADMIN_OID = '12345678-1234-4234-8234-123456789abc';
const CLIENT_ID = '99999999-8888-4777-8666-555555555555';
const CFG = {
  clientId: CLIENT_ID,
  clientSecret: 'portal-client-secret-value',
  callbackUrl: 'https://breeze.example.test/api/v1/portal/auth/oidc/entra/callback',
  consentReturnUrl: 'https://breeze.example.test/api/v1/portal/auth/oidc/entra/consent-return',
};
const PORTAL = 'https://portal.example.test/portal';
const FAILED = `${PORTAL}/entra-setup?status=failed`;
const INVALID = `${PORTAL}/entra-setup?status=invalid`;

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const savedPortalUrl = process.env.PUBLIC_PORTAL_URL;

beforeAll(() => {
  process.env.PUBLIC_PORTAL_URL = PORTAL;
});

afterAll(() => {
  if (savedPortalUrl === undefined) delete process.env.PUBLIC_PORTAL_URL;
  else process.env.PUBLIC_PORTAL_URL = savedPortalUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.current = CFG;
  h.dbRows.current = [{ orgAccess: 'all', orgIds: null }];
  h.perms.mockResolvedValue({ permissions: [{ resource: 'organizations', action: 'write' }], partnerId: PARTNER, orgId: null, roleId: 'r-1', scope: 'partner' });
  h.adminCheck.mockResolvedValue({ ok: true });
  h.activeOrg.mockResolvedValue({ orgId: ORG, partnerId: PARTNER });
  h.record.mockResolvedValue({ displaced: null });
  h.audit.mockResolvedValue(undefined);
  portalEntraProofRuns.clear();
  portalOidcStates.clear();
  portalRateLimitBuckets.clear();
});

async function newRun(over: Partial<{ orgId: string; partnerId: string; createdByUserId: string; expectedTenantId: string }> = {}) {
  return createPortalEntraProofRun({
    orgId: ORG, partnerId: PARTNER, createdByUserId: CREATOR, expectedTenantId: TENANT, ...over,
  });
}

describe('the proof-run link route', () => {
  const hostOrgId = vi.fn(async (): Promise<string | null> => null);
  const app = (secureCookie = false) => {
    const a = new Hono();
    a.get(PORTAL_ENTRA_PROOF_ROUTE, (c) => startPortalEntraTenantProof(c, { secureCookie, hostOrgId }));
    return a;
  };
  const open = (query: string, secureCookie = false) => app(secureCookie).request(`${PORTAL_ENTRA_PROOF_ROUTE}${query}`);

  it('is the path the MSP link points at', () => {
    expect(`/api/v1/portal${PORTAL_ENTRA_PROOF_ROUTE}`).toBe(PORTAL_ENTRA_PROOF_RUN_PATH);
  });

  it('a valid run → 302 to the authorize URL pinned to the run\'s tenant with the proof scope; the run is only peeked', async () => {
    const run = await newRun();
    const res = await open(`?run=${encodeURIComponent(run.token)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const url = new URL(res.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CFG.callbackUrl);
    expect(url.searchParams.get('scope')).toBe('openid profile Directory.Read.All');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    // The stored state: the run's hash (never the raw token), its org and pinned tenant.
    const stored = portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload;
    expect(JSON.parse(stored)).toMatchObject({
      purpose: { kind: 'tenant_proof', runTokenHash: sha(run.token), orgId: ORG, expectedTenantId: TENANT },
      authority: TENANT,
      hostOrgId: null,
    });
    expect(stored).not.toContain(run.token);

    // The browser binding cookie is set, Lax, on the OIDC path.
    const binding = res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='));
    expect(binding).toMatch(/^breeze_portal_oidc=[A-Za-z0-9_-]{43};/);
    expect(binding).toContain('Path=/api/v1/portal/auth/oidc');
    expect(binding).toContain('SameSite=Lax');
    expect(binding).not.toContain('Secure');

    // Peeked, not consumed: the link survives a failed sign-in.
    expect(await peekPortalEntraProofRun(run.token)).not.toBeNull();
  });

  it('records the host org the start request was served on and marks the cookie Secure when asked', async () => {
    hostOrgId.mockResolvedValueOnce(ORG);
    const run = await newRun();
    const res = await open(`?run=${encodeURIComponent(run.token)}`, true);
    const url = new URL(res.headers.get('location')!);
    expect(JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload).hostOrgId).toBe(ORG);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='))).toContain('; Secure');
  });

  it.each([
    ['an unknown run', '?run=not-a-real-run-token'],
    ['no run', ''],
    ['an empty run', '?run='],
    ['two runs', '?run=a&run=b'],
  ])('%s → 302 /entra-setup?status=invalid, no state, no cookie', async (_name, query) => {
    const res = await open(query);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(INVALID);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_oidc='))).toBe(false);
    expect(portalOidcStates.size).toBe(0);
  });

  it('an expired run → invalid', async () => {
    const run = await newRun();
    const entry = portalEntraProofRuns.get(sha(run.token))!;
    portalEntraProofRuns.set(sha(run.token), { ...entry, expiresAt: new Date(Date.now() - 1000) });
    const res = await open(`?run=${encodeURIComponent(run.token)}`);
    expect(res.headers.get('location')).toBe(INVALID);
  });

  it('a used run link → invalid', async () => {
    const run = await newRun();
    portalEntraProofRuns.delete(sha(run.token));
    const res = await open(`?run=${encodeURIComponent(run.token)}`);
    expect(res.headers.get('location')).toBe(INVALID);
    expect(portalOidcStates.size).toBe(0);
  });

  it('404 when the portal Entra app is not configured (the start routes\' rule)', async () => {
    const run = await newRun();
    h.cfg.current = null;
    const res = await open(`?run=${encodeURIComponent(run.token)}`);
    expect(res.status).toBe(404);
    expect(portalOidcStates.size).toBe(0);
  });

  it('is rate limited per IP (10 per 15 min) on the proof bucket', async () => {
    for (let i = 0; i < 10; i++) expect((await open('?run=x')).status).toBe(302);
    const res = await open('?run=x');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect([...portalRateLimitBuckets.keys()].some((k) => k.startsWith('portal:oidc:proof:ip:'))).toBe(true);
  });
});

describe('the tenant_proof callback branch', () => {
  type Input = PortalTenantProofCallbackInput;
  const identity = (tid = TENANT): Input['identity'] => ({
    provider: 'entra', issuer: entraIssuer(tid), subject: ADMIN_OID, entraTenantId: tid,
    upn: 'admin@customer.test', emailClaim: null, emailDomainOwnerVerified: false, name: 'Admin',
  });
  const graphFetch = vi.fn() as unknown as typeof fetch;

  async function call(input: Partial<Input> & { runToken: string }) {
    const { runToken, ...rest } = input;
    const full: Input = {
      cfg: CFG,
      purpose: { kind: 'tenant_proof', runTokenHash: sha(runToken), orgId: ORG, expectedTenantId: TENANT },
      identity: identity(),
      accessToken: 'graph-access-token',
      ...rest,
    };
    let location = '';
    const app = new Hono();
    app.get('/cb', async (c) => {
      location = await handleTenantProofCallback(c, full, { graphFetch });
      return c.text('ok');
    });
    await app.request('/cb');
    return location;
  }

  const refusalAudits = () => h.audit.mock.calls.map((call) => call[1]);

  it('an admin of the pinned tenant: Graph check → consume → record via proof_run → the tenant\'s admin consent', async () => {
    const run = await newRun();
    const location = await call({ runToken: run.token });

    const consent = new URL(location);
    expect(`${consent.origin}${consent.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0/adminconsent`);
    expect(consent.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(consent.searchParams.get('redirect_uri')).toBe(CFG.consentReturnUrl);

    expect(h.adminCheck).toHaveBeenCalledWith('graph-access-token', { tid: TENANT, oid: ADMIN_OID }, { fetch: graphFetch });
    expect(h.activeOrg).toHaveBeenCalledWith(ORG);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith({
      orgId: ORG, tenantId: TENANT, via: 'proof_run', evidence: { adminOid: ADMIN_OID, runId: run.runId }, provenByUserId: CREATOR,
    });
    // Consumed: the link is spent.
    expect(await peekPortalEntraProofRun(run.token)).toBeNull();
    // The service audits `.proven`; the branch writes no refusal row.
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('a failed refusal-audit write is captured and the redirect is unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.audit.mockRejectedValue(new Error('audit insert failed'));
      h.adminCheck.mockResolvedValue({ ok: false, reason: 'no_accepted_role' });
      const run = await newRun();
      expect(await call({ runToken: run.token })).toBe(FAILED);
      expect(h.capture).toHaveBeenCalledTimes(1);
      const captured = h.capture.mock.calls[0]![0];
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toBe('audit insert failed');
      expect(JSON.stringify(h.capture.mock.calls)).not.toContain(run.token);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('not an admin (Graph check fails) → failed, the reason audited, the run NOT consumed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.adminCheck.mockResolvedValue({ ok: false, reason: 'no_accepted_role' });
      const run = await newRun();
      expect(await call({ runToken: run.token })).toBe(FAILED);
      expect(await peekPortalEntraProofRun(run.token)).not.toBeNull();
      expect(h.record).not.toHaveBeenCalled();
      expect(refusalAudits()).toEqual([expect.objectContaining({
        orgId: ORG,
        action: 'organization.portal_identity_proof.failed',
        resourceType: 'organization',
        resourceId: ORG,
        result: 'failure',
        details: { reason: 'admin_check_failed', adminCheck: 'no_accepted_role' },
      })]);
      expect(JSON.stringify(warn.mock.calls)).toContain('admin_check_failed');
      // Never a token in the log or the audit row.
      expect(JSON.stringify([warn.mock.calls, h.audit.mock.calls])).not.toContain('graph-access-token');
      expect(JSON.stringify([warn.mock.calls, h.audit.mock.calls])).not.toContain(run.token);
    } finally {
      warn.mockRestore();
    }
  });

  it('no access token → failed without a Graph call; the run NOT consumed', async () => {
    const run = await newRun();
    expect(await call({ runToken: run.token, accessToken: null })).toBe(FAILED);
    expect(h.adminCheck).not.toHaveBeenCalled();
    expect(await peekPortalEntraProofRun(run.token)).not.toBeNull();
    expect(refusalAudits()[0]).toMatchObject({ details: { reason: 'no_access_token' } });
  });

  it('a token for another tenant than the run\'s pin → failed before Graph (defence in depth)', async () => {
    const run = await newRun();
    expect(await call({ runToken: run.token, identity: identity(OTHER_TENANT) })).toBe(FAILED);
    expect(h.adminCheck).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(await peekPortalEntraProofRun(run.token)).not.toBeNull();
    expect(refusalAudits()[0]).toMatchObject({ details: { reason: 'tenant_mismatch' } });
  });

  it('the run is gone (used, expired) → invalid', async () => {
    const run = await newRun();
    portalEntraProofRuns.delete(sha(run.token));
    expect(await call({ runToken: run.token })).toBe(INVALID);
    expect(h.record).not.toHaveBeenCalled();
    expect(refusalAudits()[0]).toMatchObject({ details: { reason: 'run_unavailable' } });
  });

  it('a run of another org than the state names → invalid, nothing recorded', async () => {
    const run = await newRun({ orgId: '8c0a1f7e-1111-4222-8333-444455556666' });
    expect(await call({ runToken: run.token })).toBe(INVALID);
    expect(h.record).not.toHaveBeenCalled();
    expect(refusalAudits()[0]).toMatchObject({ orgId: ORG, details: { reason: 'run_mismatch' } });
  });

  it.each([
    ['the org is no longer active', null],
    ['the org moved to another partner', { orgId: ORG, partnerId: '4b0a1f7e-1111-4222-8333-444455556666' }],
  ])('%s → invalid, nothing recorded, the run spent', async (_name, active) => {
    h.activeOrg.mockResolvedValue(active);
    const run = await newRun();
    expect(await call({ runToken: run.token })).toBe(INVALID);
    expect(h.record).not.toHaveBeenCalled();
    expect(await peekPortalEntraProofRun(run.token)).toBeNull();
    expect(refusalAudits()[0]).toMatchObject({ details: { reason: 'org_unavailable' } });
  });

  it.each([
    ['no longer an active member of the org\'s partner', []],
    ['a member whose org access is none', [{ orgAccess: 'none', orgIds: null }]],
    ['a member whose selection no longer covers the org', [{ orgAccess: 'selected', orgIds: ['8c0a1f7e-1111-4222-8333-444455556666'] }]],
  ])('the link\'s creator is %s → invalid, nothing recorded', async (_name, rows) => {
    h.dbRows.current = rows;
    const run = await newRun();
    expect(await call({ runToken: run.token })).toBe(INVALID);
    expect(h.record).not.toHaveBeenCalled();
    expect(refusalAudits()[0]).toMatchObject({ details: { reason: 'creator_unauthorized' } });
  });

  it.each([
    ['whose role no longer grants organizations:write', { permissions: [{ resource: 'organizations', action: 'read' }], partnerId: PARTNER, orgId: null, roleId: 'r-1', scope: 'partner' }],
    ['with no resolvable permissions', null],
  ])('the link\'s creator %s → invalid, nothing recorded', async (_name, perms) => {
    h.perms.mockResolvedValue(perms);
    const run = await newRun();
    expect(await call({ runToken: run.token })).toBe(INVALID);
    expect(h.record).not.toHaveBeenCalled();
    expect(refusalAudits()[0]).toMatchObject({ details: { reason: 'creator_unauthorized' } });
    expect(h.perms).toHaveBeenCalledWith(expect.any(String), { partnerId: PARTNER, scope: 'partner' }, { bypassCache: true });
  });

  it('a creator whose selection covers the org still authorizes the proof', async () => {
    h.dbRows.current = [{ orgAccess: 'selected', orgIds: [ORG] }];
    const run = await newRun();
    expect(await call({ runToken: run.token })).toMatch(/\/adminconsent\?/);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('a refused record (PortalEntraProofError) → failed with its code audited; the run is spent', async () => {
    h.record.mockRejectedValue(new PortalEntraProofError('PORTAL_ENTRA_ORG_HAS_OTHER_TENANT', 409, 'other tenant'));
    const run = await newRun();
    expect(await call({ runToken: run.token })).toBe(FAILED);
    expect(await peekPortalEntraProofRun(run.token)).toBeNull();
    expect(refusalAudits()[0]).toMatchObject({
      action: 'organization.portal_identity_proof.failed',
      details: { reason: 'proof_refused', code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT' },
    });
  });

  it('any other record failure propagates (the shared callback answers 302 failed)', async () => {
    h.record.mockRejectedValue(new Error('connection terminated'));
    const run = await newRun();
    const app = new Hono();
    app.get('/cb', async (c) => c.text(await handleTenantProofCallback(c, {
      cfg: CFG,
      purpose: { kind: 'tenant_proof', runTokenHash: sha(run.token), orgId: ORG, expectedTenantId: TENANT },
      identity: identity(),
      accessToken: 'graph-access-token',
    })));
    const res = await app.request('/cb');
    expect(res.status).toBe(500);
  });

  it('two callbacks for one run: one proof, the other invalid', async () => {
    const run = await newRun();
    const [a, b] = await Promise.all([call({ runToken: run.token }), call({ runToken: run.token })]);
    expect([a, b].filter((l) => l.includes('/adminconsent?'))).toHaveLength(1);
    expect([a, b].filter((l) => l === INVALID)).toHaveLength(1);
    expect(h.record).toHaveBeenCalledTimes(1);
  });
});

describe('entraSetupResult', () => {
  it('builds the fixed portal result page', () => {
    expect(entraSetupResult('consent_done')).toBe(`${PORTAL}/entra-setup?status=consent_done`);
  });
});
