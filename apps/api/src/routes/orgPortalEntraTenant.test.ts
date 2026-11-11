import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route tests for the MSP Entra tenant-proof routes (portal registration W4
 * #11381, Task 8). The Task 2 service is mocked (its real-DB behaviour is
 * proved in portalEntraTenantProof.integration.test.ts, including these routes
 * through the real router); the proof-run store, the hint parser, the portal
 * Entra config and the admin-consent URL builder are real.
 */
const h = vi.hoisted(() => {
  const organizations = { id: 'organizations.id', partnerId: 'organizations.partner_id', deletedAt: 'organizations.deleted_at' };
  const store = {
    // What the org lookup returns (the fake does not evaluate WHERE clauses).
    orgs: [] as Array<{ id: string; partnerId: string }>,
  };
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => {
          const rows = store.orgs.map((r) => ({ ...r }));
          return Object.assign(Promise.resolve(rows), { limit: async (n: number) => rows.slice(0, n) });
        },
      }),
    })),
  };
  /** >0 while a callback runs inside runOutsideDbContext. */
  const ctx = { outsideDepth: 0 };
  /** Each service call, with whether it ran outside the request's DB context. */
  const calls: Array<{ fn: string; args: unknown[]; outside: boolean }> = [];
  const record = (fn: string, impl: { current: (...args: any[]) => Promise<unknown> }) =>
    (...args: unknown[]) => {
      calls.push({ fn, args, outside: ctx.outsideDepth > 0 });
      return impl.current(...args);
    };
  const getStatusImpl = { current: async (..._args: any[]): Promise<unknown> => undefined };
  const proveImpl = { current: async (..._args: any[]): Promise<unknown> => undefined };
  const removeImpl = { current: async (..._args: any[]): Promise<unknown> => undefined };
  return {
    organizations,
    store,
    db,
    ctx,
    calls,
    getStatus: record('getPortalEntraTenantStatus', getStatusImpl),
    prove: record('proveEntraTenantFromM365Connection', proveImpl),
    remove: record('removePortalEntraTenant', removeImpl),
    getStatusImpl,
    proveImpl,
    removeImpl,
    resolveDomain: vi.fn(async (_domain: string): Promise<{ kind: 'tenant'; tid: string } | { kind: 'unknown_domain' } | { kind: 'lookup_failed' }> => ({ kind: 'unknown_domain' })),
    authRef: { current: null as any },
    auditSpy: vi.fn(),
    holding: { current: false },
  };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!h.authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', h.authRef.current);
    await next();
  }),
  // Real-shaped gates: each denies when the stub auth lacks what it checks, so a
  // dropped requireScope / requirePermission / requireMfa reds a test.
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms: string[] | undefined = c.get('auth').perms;
    if (perms && !perms.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    await next();
  },
  requireMfa: () => async (c: any, next: any) => {
    if (c.get('auth').mfa === false) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    await next();
  },
}));

vi.mock('../db', () => ({
  db: h.db,
  runOutsideDbContext: (fn: () => unknown) => {
    h.ctx.outsideDepth += 1;
    try {
      return fn();
    } finally {
      h.ctx.outsideDepth -= 1;
    }
  },
}));

vi.mock('../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/auditEvents')>()),
  writeRouteAudit: (...args: unknown[]) => h.auditSpy(...args),
}));

vi.mock('../services/unassignedPool/protectedOrg', () => ({
  isHoldingOrg: async () => h.holding.current,
}));

vi.mock('../services/portalEntraTenantProof', () => {
  class PortalEntraProofError extends Error {
    constructor(readonly code: string, readonly httpStatus: 409 | 422, message: string) {
      super(message);
      this.name = 'PortalEntraProofError';
    }
  }
  return {
    PortalEntraProofError,
    getPortalEntraTenantStatus: h.getStatus,
    proveEntraTenantFromM365Connection: h.prove,
    removePortalEntraTenant: h.remove,
  };
});

vi.mock('../services/portalOidc/tenantHint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/portalOidc/tenantHint')>()),
  resolveEntraTenantIdFromDomain: (domain: string) => h.resolveDomain(domain),
}));

import { authMiddleware } from '../middleware/auth';
import { PortalEntraProofError } from '../services/portalEntraTenantProof';
import { peekPortalEntraProofRun } from '../services/portalOidc/proofRunStore';
import { portalEntraProofRuns } from './portal/helpers';
import { registerPortalEntraTenantRoutes } from './orgPortalEntraTenant';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '7c0a1f7e-9999-4222-8333-444455556666';
const PARTNER_ID = '5d0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const TID = 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5';
const OTHER_TID = 'b2b2b2b2-c3c3-4d4d-8e5e-f6f6f6f6f6f6';
const CONNECTION_TID = 'c3c3c3c3-d4d4-4e5e-8f6f-a7a7a7a7a7a7';
const CLIENT_ID = 'd4d4d4d4-e5e5-4f6f-8a7a-b8b8b8b8b8b8';
const BASE = `/organizations/${ORG_ID}/portal-entra-tenant`;
const PROOF_LINKS = `${BASE}/proof-links`;
const PROVE = `${BASE}/prove-from-connection`;

const FULL_ADMIN = {
  scope: 'partner',
  user: { id: USER_ID, email: 'tess@msp.example' },
  partnerId: PARTNER_ID,
  orgId: null,
  partnerOrgAccess: 'all',
  canAccessOrg: (_id: string) => true,
};
const SELECTED = { ...FULL_ADMIN, partnerOrgAccess: 'selected', canAccessOrg: (id: string) => id === OTHER_ORG_ID };
const NO_MFA = { ...FULL_ADMIN, mfa: false };
const ORG_TOKEN = {
  scope: 'organization',
  user: { id: USER_ID, email: 'owner@customer.example' },
  partnerId: PARTNER_ID,
  orgId: ORG_ID,
  canAccessOrg: (id: string) => id === ORG_ID,
};

type Status = {
  tenantId: string | null;
  state: 'none' | 'unproven' | 'proven';
  provenAt: string | null;
  provenVia: 'm365_connection' | 'proof_run' | null;
  connectionTenantId: string | null;
};
const NONE: Status = { tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null };
const UNPROVEN: Status = { ...NONE, tenantId: TID, state: 'unproven' };
const PROVEN: Status = { ...NONE, tenantId: TID, state: 'proven', provenAt: '2027-01-23T10:00:00.000Z', provenVia: 'proof_run' };

const ENV_KEYS = ['PORTAL_ENTRA_CLIENT_ID', 'PORTAL_ENTRA_CLIENT_SECRET', 'PORTAL_ENTRA_CALLBACK_BASE_URL'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function configure() {
  process.env.PORTAL_ENTRA_CLIENT_ID = CLIENT_ID;
  process.env.PORTAL_ENTRA_CLIENT_SECRET = 'portal-app-secret';
  process.env.PORTAL_ENTRA_CALLBACK_BASE_URL = 'https://portal.msp.example';
}

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerPortalEntraTenantRoutes(app);
  return app;
}

function post(body?: unknown) {
  return body === undefined
    ? { method: 'POST' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function status(s: Status) {
  h.getStatusImpl.current = async () => ({ ...s });
}

function serviceCalls(fn: string) {
  return h.calls.filter((c) => c.fn === fn);
}

beforeEach(() => {
  vi.clearAllMocks();
  configure();
  h.authRef.current = FULL_ADMIN;
  h.store.orgs = [{ id: ORG_ID, partnerId: PARTNER_ID }];
  h.holding.current = false;
  h.calls.length = 0;
  h.ctx.outsideDepth = 0;
  status(NONE);
  h.proveImpl.current = async () => ({ displaced: null, tenantId: TID });
  h.removeImpl.current = async () => ({ removed: false, tenantId: null });
  h.resolveDomain.mockImplementation(async () => ({ kind: 'unknown_domain' }));
  portalEntraProofRuns.clear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('every route', () => {
  it('every route → 404 PORTAL_ENTRA_NOT_CONFIGURED without the portal app env', async () => {
    delete process.env.PORTAL_ENTRA_CLIENT_ID;
    delete process.env.PORTAL_ENTRA_CLIENT_SECRET;
    status(PROVEN);
    const app = makeApp();
    const responses = [
      await app.request(BASE),
      await app.request(PROVE, post()),
      await app.request(PROOF_LINKS, post({ tenant: TID })),
      await app.request(BASE, { method: 'DELETE' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: expect.any(String), code: 'PORTAL_ENTRA_NOT_CONFIGURED' });
    }
    expect(h.calls).toEqual([]);
    expect(h.auditSpy).not.toHaveBeenCalled();
    expect(portalEntraProofRuns.size).toBe(0);
  });

  it('an organization-scope token is refused on every route', async () => {
    h.authRef.current = ORG_TOKEN;
    const app = makeApp();
    for (const res of [
      await app.request(BASE),
      await app.request(PROVE, post()),
      await app.request(PROOF_LINKS, post({ tenant: TID })),
      await app.request(BASE, { method: 'DELETE' }),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });

  it('a partner user without the org permission is refused (read and write)', async () => {
    h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:read'] };
    const app = makeApp();
    status(UNPROVEN);
    expect((await app.request(BASE)).status).toBe(200);
    expect((await app.request(PROOF_LINKS, post())).status).toBe(403);
    expect((await app.request(PROVE, post())).status).toBe(403);
    expect((await app.request(BASE, { method: 'DELETE' })).status).toBe(403);

    h.authRef.current = { ...FULL_ADMIN, perms: [] };
    expect((await app.request(BASE)).status).toBe(403);
  });
});

describe('GET /organizations/:id/portal-entra-tenant', () => {
  it('GET status for an org the partner cannot access → 404', async () => {
    h.authRef.current = SELECTED;
    const res = await makeApp().request(BASE);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(h.calls).toEqual([]);
  });

  it('GET status for a missing org → 404', async () => {
    h.store.orgs = [];
    const res = await makeApp().request(BASE);
    expect(res.status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it('returns the tenant state, read outside the request context, with a consent URL only for a proven tenant', async () => {
    status(PROVEN);
    const proven = await makeApp().request(BASE);
    expect(proven.status).toBe(200);
    const { data } = await proven.json();
    expect(data).toMatchObject(PROVEN);
    const consent = new URL(data.consentUrl);
    expect(`${consent.origin}${consent.pathname}`).toBe(`https://login.microsoftonline.com/${TID}/v2.0/adminconsent`);
    expect(consent.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(consent.searchParams.get('redirect_uri')).toBe('https://portal.msp.example/api/v1/portal/auth/oidc/entra/consent-return');
    expect(serviceCalls('getPortalEntraTenantStatus')).toEqual([{ fn: 'getPortalEntraTenantStatus', args: [ORG_ID], outside: true }]);

    status({ ...UNPROVEN, connectionTenantId: CONNECTION_TID });
    const unproven = await (await makeApp().request(BASE)).json();
    expect(unproven.data).toEqual({ ...UNPROVEN, connectionTenantId: CONNECTION_TID, consentUrl: null });

    status(NONE);
    expect((await (await makeApp().request(BASE)).json()).data).toEqual({ ...NONE, consentUrl: null });
    expect(h.auditSpy).not.toHaveBeenCalled();
  });
});

describe('POST /organizations/:id/portal-entra-tenant/proof-links', () => {
  async function createLink(body?: unknown) {
    const res = await makeApp().request(PROOF_LINKS, post(body));
    return { res, body: await res.json() };
  }

  async function runFor(url: string) {
    const parsed = new URL(url);
    return peekPortalEntraProofRun(parsed.searchParams.get('run') ?? '');
  }

  it('proof-links returns a url under the callback base and audits link_created; no MFA → refused', async () => {
    status(UNPROVEN);
    const before = Date.now();
    const { res, body } = await createLink();
    expect(res.status).toBe(200);
    const { url, expiresAt, expectedTenantId } = body.data;
    expect(expectedTenantId).toBe(TID);

    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://portal.msp.example/api/v1/portal/auth/oidc/entra/proof');
    expect([...parsed.searchParams.keys()]).toEqual(['run']);
    const token = parsed.searchParams.get('run')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const run = await runFor(url);
    expect(run?.record).toMatchObject({ orgId: ORG_ID, partnerId: PARTNER_ID, createdByUserId: USER_ID, expectedTenantId: TID });
    const expiry = new Date(expiresAt).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 72 * 3600 * 1000 - 1000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 72 * 3600 * 1000);

    expect(h.auditSpy).toHaveBeenCalledTimes(1);
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'organization.portal_identity_proof.link_created',
      resourceType: 'organization',
      resourceId: ORG_ID,
      details: { runId: run!.record.runId, expectedTenantId: TID, tenantSource: 'mapping', expiresAt },
    });
    // The token is a capability: never in the audit row.
    expect(JSON.stringify(h.auditSpy.mock.calls)).not.toContain(token);
    expect(serviceCalls('getPortalEntraTenantStatus').every((c) => c.outside)).toBe(true);

    h.authRef.current = NO_MFA;
    const refused = await makeApp().request(PROOF_LINKS, post());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(portalEntraProofRuns.size).toBe(1);
    expect(h.auditSpy).toHaveBeenCalledTimes(1);
  });

  it("the org's mapped tenant always wins: a hint for another tenant → 409 ORG_HAS_OTHER_TENANT", async () => {
    status({ ...UNPROVEN, connectionTenantId: CONNECTION_TID });

    const other = await createLink({ tenant: OTHER_TID });
    expect(other.res.status).toBe(409);
    expect(other.body).toEqual({ error: expect.any(String), code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT' });

    h.resolveDomain.mockImplementation(async () => ({ kind: 'tenant', tid: OTHER_TID }));
    const otherDomain = await createLink({ tenant: 'fabrikam.com' });
    expect(otherDomain.res.status).toBe(409);
    expect(otherDomain.body.code).toBe('PORTAL_ENTRA_ORG_HAS_OTHER_TENANT');
    expect(portalEntraProofRuns.size).toBe(0);
    expect(h.auditSpy).not.toHaveBeenCalled();

    // A hint naming the mapped tenant itself is fine.
    const same = await createLink({ tenant: TID.toUpperCase() });
    expect(same.res.status).toBe(200);
    expect(same.body.data.expectedTenantId).toBe(TID);
    expect(h.auditSpy.mock.calls[0]![1].details.tenantSource).toBe('mapping');

    // A mapping no proof could ever match (the consumer tenant, typed into the
    // AI for Office PUT) is not silently skipped for the connection tenant.
    status({ ...UNPROVEN, tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad', connectionTenantId: CONNECTION_TID });
    const unprovable = await createLink();
    expect(unprovable.res.status).toBe(409);
    expect(unprovable.body.code).toBe('PORTAL_ENTRA_ORG_HAS_OTHER_TENANT');
    expect(portalEntraProofRuns.size).toBe(1);
  });

  it('with no mapping a GUID hint pins that tenant, and a domain hint pins the tid it resolves to', async () => {
    status({ ...NONE, connectionTenantId: CONNECTION_TID });

    const guid = await createLink({ tenant: ` ${OTHER_TID.toUpperCase()} ` });
    expect(guid.res.status).toBe(200);
    expect(guid.body.data.expectedTenantId).toBe(OTHER_TID);
    expect((await runFor(guid.body.data.url))?.record.expectedTenantId).toBe(OTHER_TID);
    expect(h.resolveDomain).not.toHaveBeenCalled();

    h.resolveDomain.mockImplementation(async () => ({ kind: 'tenant', tid: TID }));
    const domain = await createLink({ tenant: 'Contoso.com' });
    expect(domain.res.status).toBe(200);
    expect(domain.body.data.expectedTenantId).toBe(TID);
    expect(h.resolveDomain).toHaveBeenCalledWith('contoso.com');
    expect((await runFor(domain.body.data.url))?.record.expectedTenantId).toBe(TID);
    expect(h.auditSpy.mock.calls.map((call) => call[1].details.tenantSource)).toEqual(['hint', 'hint']);
  });

  it('a domain hint that does not resolve, or a malformed hint, → 422 PORTAL_ENTRA_TENANT_HINT_INVALID', async () => {
    status({ ...NONE, connectionTenantId: CONNECTION_TID });

    const unresolved = await createLink({ tenant: 'unknown-domain.example' });
    expect(unresolved.res.status).toBe(422);
    expect(unresolved.body).toEqual({ error: expect.any(String), code: 'PORTAL_ENTRA_TENANT_HINT_INVALID' });
    expect(h.resolveDomain).toHaveBeenCalledTimes(1);

    for (const tenant of ['contoso.com/../common', 'organizations', 'user@contoso.com', '9188040d-6c67-4c5b-b112-36a304b66dad']) {
      const malformed = await createLink({ tenant });
      expect(malformed.res.status).toBe(422);
      expect(malformed.body.code).toBe('PORTAL_ENTRA_TENANT_HINT_INVALID');
    }
    expect(h.resolveDomain).toHaveBeenCalledTimes(1);
    expect(portalEntraProofRuns.size).toBe(0);
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('a Microsoft lookup outage → 503 PORTAL_ENTRA_TENANT_HINT_LOOKUP_FAILED, not an invalid-hint 422', async () => {
    status({ ...NONE, connectionTenantId: CONNECTION_TID });
    h.resolveDomain.mockImplementation(async () => ({ kind: 'lookup_failed' }));

    const failed = await createLink({ tenant: 'contoso.com' });
    expect(failed.res.status).toBe(503);
    expect(failed.body).toEqual({
      error: "Couldn't reach Microsoft to look up that domain. Try again, or enter the tenant ID.",
      code: 'PORTAL_ENTRA_TENANT_HINT_LOOKUP_FAILED',
    });
    expect(portalEntraProofRuns.size).toBe(0);
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it("no hint falls back to the org's M365 connection tenant; nothing at all → 422 TENANT_HINT_REQUIRED", async () => {
    status({ ...NONE, connectionTenantId: CONNECTION_TID.toUpperCase() });
    const connection = await createLink({});
    expect(connection.res.status).toBe(200);
    expect(connection.body.data.expectedTenantId).toBe(CONNECTION_TID);
    expect(h.auditSpy.mock.calls[0]![1].details.tenantSource).toBe('connection');

    status(NONE);
    for (const body of [undefined, {}, { tenant: '' }, { tenant: '   ' }]) {
      const required = await createLink(body);
      expect(required.res.status).toBe(422);
      expect(required.body).toEqual({ error: expect.any(String), code: 'PORTAL_ENTRA_TENANT_HINT_REQUIRED' });
    }
    expect(portalEntraProofRuns.size).toBe(1);
  });

  it('refuses the holding org (409 ORG_PROTECTED), an inaccessible org (404) and a malformed body (400)', async () => {
    status(UNPROVEN);
    h.holding.current = true;
    const holding = await createLink();
    expect(holding.res.status).toBe(409);
    expect(holding.body).toEqual({ error: expect.any(String), code: 'ORG_PROTECTED' });

    h.holding.current = false;
    h.authRef.current = SELECTED;
    expect((await createLink()).res.status).toBe(404);

    h.authRef.current = FULL_ADMIN;
    expect((await createLink({ tenant: 42 })).res.status).toBe(400);
    expect((await createLink({ tenant: TID, orgId: OTHER_ORG_ID })).res.status).toBe(400);
    expect((await createLink({ tenant: `${'a'.repeat(300)}.com` })).res.status).toBe(400);

    expect(portalEntraProofRuns.size).toBe(0);
    expect(h.auditSpy).not.toHaveBeenCalled();
  });
});

describe('POST /organizations/:id/portal-entra-tenant/prove-from-connection', () => {
  it('proves outside the request context as the acting user and returns the fresh status', async () => {
    status({ ...PROVEN, provenVia: 'm365_connection', connectionTenantId: TID });
    const res = await makeApp().request(PROVE, post());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ...PROVEN, provenVia: 'm365_connection', connectionTenantId: TID });
    expect(serviceCalls('proveEntraTenantFromM365Connection')).toEqual([
      { fn: 'proveEntraTenantFromM365Connection', args: [ORG_ID, USER_ID], outside: true },
    ]);
    expect(serviceCalls('getPortalEntraTenantStatus').every((c) => c.outside)).toBe(true);
  });

  it('prove-from-connection maps TENANT_PROVEN_ELSEWHERE to 409 with code', async () => {
    h.proveImpl.current = async () => {
      throw new PortalEntraProofError('PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE', 409, 'This Microsoft tenant is already proven for another organization.');
    };
    const res = await makeApp().request(PROVE, post());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This Microsoft tenant is already proven for another organization.',
      code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE',
    });
  });

  it('maps NO_VERIFIED_CONNECTION to 422 and PROTECTED_ORG to 409 with the existing PROTECTED_ORG_ERROR body', async () => {
    h.proveImpl.current = async () => {
      throw new PortalEntraProofError('PORTAL_ENTRA_NO_VERIFIED_CONNECTION', 422, 'No verified connection.');
    };
    const noConnection = await makeApp().request(PROVE, post());
    expect(noConnection.status).toBe(422);
    expect(await noConnection.json()).toEqual({ error: 'No verified connection.', code: 'PORTAL_ENTRA_NO_VERIFIED_CONNECTION' });

    h.proveImpl.current = async () => {
      throw new PortalEntraProofError('PORTAL_ENTRA_PROTECTED_ORG', 409, 'protected');
    };
    const holding = await makeApp().request(PROVE, post());
    expect(holding.status).toBe(409);
    expect(await holding.json()).toEqual({
      error: 'The unassigned-device holding area is managed by Breeze and cannot be changed here',
      code: 'ORG_PROTECTED',
    });
  });

  it('an unexpected service failure is not mapped to a 4xx', async () => {
    h.proveImpl.current = async () => { throw new Error('connection reset'); };
    const res = await makeApp().request(PROVE, post());
    expect(res.status).toBe(500);
  });

  it('no MFA → refused; an inaccessible org → 404; neither calls the service', async () => {
    h.authRef.current = NO_MFA;
    expect((await makeApp().request(PROVE, post())).status).toBe(403);
    h.authRef.current = SELECTED;
    expect((await makeApp().request(PROVE, post())).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe('DELETE /organizations/:id/portal-entra-tenant', () => {
  it('DELETE removes the mapping and audits removed', async () => {
    h.removeImpl.current = async () => ({ removed: true, tenantId: TID });
    const res = await makeApp().request(BASE, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { removed: true, tenantId: TID } });
    expect(serviceCalls('removePortalEntraTenant')).toEqual([{ fn: 'removePortalEntraTenant', args: [ORG_ID], outside: true }]);
    expect(h.auditSpy).toHaveBeenCalledTimes(1);
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'organization.portal_identity_proof.removed',
      resourceType: 'organization',
      resourceId: ORG_ID,
      resourceName: TID,
      details: { tenantId: TID },
    });
  });

  it('DELETE with nothing mapped → removed false, no audit', async () => {
    const res = await makeApp().request(BASE, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { removed: false, tenantId: null } });
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('DELETE without MFA or for an inaccessible org removes nothing', async () => {
    h.removeImpl.current = async () => ({ removed: true, tenantId: TID });
    h.authRef.current = NO_MFA;
    expect((await makeApp().request(BASE, { method: 'DELETE' })).status).toBe(403);
    h.authRef.current = SELECTED;
    expect((await makeApp().request(BASE, { method: 'DELETE' })).status).toBe(404);
    expect(h.calls).toEqual([]);
    expect(h.auditSpy).not.toHaveBeenCalled();
  });
});
