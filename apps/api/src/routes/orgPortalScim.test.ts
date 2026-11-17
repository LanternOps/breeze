import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route tests for the MSP SCIM token routes (portal registration W9 #11386,
 * plan Task 6; D11). The services are mocked — their behaviour and audits are
 * proven in services/portalScim/tokens.test.ts and the W9 integration suite.
 * These pin the gates (scope, permission, MFA), the org check, body
 * validation, the context rule (services run outside the request's DB
 * context), the refusal mapping, and that only the mint response carries the
 * secret.
 */
const h = vi.hoisted(() => {
  const store = { orgs: [] as Array<{ id: string; partnerId: string }> };
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
  const ctx = { outsideDepth: 0 };
  const calls: Array<{ fn: string; args: unknown[]; outside: boolean }> = [];
  const impls: Record<string, (...args: any[]) => Promise<unknown>> = {};
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args, outside: ctx.outsideDepth > 0 });
    return impls[fn]!(...args);
  };
  return { store, db, ctx, calls, impls, record, authRef: { current: null as any } };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!h.authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', h.authRef.current);
    await next();
  }),
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

vi.mock('../services/portalScim/tokens', () => {
  class PortalScimTokenError extends Error {
    constructor(readonly code: string, readonly httpStatus: 404 | 409, message: string) {
      super(message);
      this.name = 'PortalScimTokenError';
    }
  }
  return {
    PortalScimTokenError,
    listPortalScimTokens: h.record('listPortalScimTokens'),
    mintPortalScimToken: h.record('mintPortalScimToken'),
    revokePortalScimToken: h.record('revokePortalScimToken'),
  };
});
vi.mock('../services/portalScim/users', () => ({ countPortalScimUsers: h.record('countPortalScimUsers') }));
vi.mock('../services/portalEntraTenantProof', () => ({ getPortalEntraTenantStatus: h.record('getPortalEntraTenantStatus') }));
// The public router module pulls in the whole SCIM stack; only its base path is needed here.
vi.mock('./portalScim', () => ({ PORTAL_SCIM_BASE_PATH: '/api/v1/scim/portal/v2' }));

import { authMiddleware } from '../middleware/auth';
import { PortalScimTokenError } from '../services/portalScim/tokens';
import { registerOrgPortalScimRoutes } from './orgPortalScim';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '7c0a1f7e-9999-4222-8333-444455556666';
const PARTNER_ID = '5d0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const TOKEN_ID = '22222222-3333-4444-8555-666677778888';
const TID = '33333333-4444-4555-8666-777788889999';
const SECRET_TOKEN = `brzscim_${'a'.repeat(32)}_${'S'.repeat(43)}`;

const BASE = `/organizations/${ORG_ID}/portal-scim`;
const TOKENS = `${BASE}/tokens`;
const ONE = `${TOKENS}/${TOKEN_ID}`;

const FULL_ADMIN = {
  scope: 'partner',
  user: { id: USER_ID, email: 'tess@msp.example' },
  partnerId: PARTNER_ID,
  orgId: null,
  partnerOrgAccess: 'all',
  canAccessOrg: (_id: string) => true,
};
const SELECTED = { ...FULL_ADMIN, partnerOrgAccess: 'selected', canAccessOrg: (id: string) => id === OTHER_ORG_ID };
const ORG_TOKEN = { scope: 'organization', user: { id: USER_ID, email: 'o@c.example' }, partnerId: PARTNER_ID, orgId: ORG_ID, canAccessOrg: (id: string) => id === ORG_ID };

const VIEW = { id: TOKEN_ID, label: 'Entra', hint: 'SSSS', tenantId: TID, createdAt: '2027-02-01T12:00:00.000Z', lastUsedAt: null, revokedAt: null, usable: true };

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgPortalScimRoutes(app);
  return app;
}
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = () => ({ method: 'DELETE' });
const serviceCalls = (fn: string) => h.calls.filter((c) => c.fn === fn);

beforeEach(() => {
  vi.clearAllMocks();
  h.authRef.current = FULL_ADMIN;
  h.store.orgs = [{ id: ORG_ID, partnerId: PARTNER_ID }];
  h.calls.length = 0;
  h.ctx.outsideDepth = 0;
  process.env.PUBLIC_API_URL = 'https://api.example.com/';
  h.impls.getPortalEntraTenantStatus = async () => ({ tenantId: TID, state: 'proven', provenAt: null, provenVia: null, connectionTenantId: null });
  h.impls.listPortalScimTokens = async () => [VIEW];
  h.impls.countPortalScimUsers = async () => ({ provisioned: 3, deactivated: 1 });
  h.impls.mintPortalScimToken = async () => ({ token: SECRET_TOKEN, view: VIEW });
  h.impls.revokePortalScimToken = async () => undefined;
});

describe('GET /organizations/:id/portal-scim', () => {
  it('returns the tenant, the Tenant URL, the tokens (no secret) and counts, from outside the request context', async () => {
    const res = await makeApp().request(BASE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      tenant: { proven: true, tenantId: TID },
      baseUrl: 'https://api.example.com/api/v1/scim/portal/v2',
      tokens: [VIEW],
      counts: { provisioned: 3, deactivated: 1 },
    });
    expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);
    expect(h.calls.every((c) => c.outside)).toBe(true);
  });

  it('an unproven tenant reports proven false and no tenant id; no public URL reports baseUrl null', async () => {
    h.impls.getPortalEntraTenantStatus = async () => ({ tenantId: TID, state: 'unproven', provenAt: null, provenVia: null, connectionTenantId: null });
    delete process.env.PUBLIC_API_URL;
    delete process.env.API_URL;
    const body = await (await makeApp().request(BASE)).json();
    expect(body.data.tenant).toEqual({ proven: false, tenantId: null });
    expect(body.data.baseUrl).toBeNull();
  });
});

describe('POST /organizations/:id/portal-scim/tokens', () => {
  it('mints with the trimmed label and the actor, returns the secret once, no-store', async () => {
    const res = await makeApp().request(TOKENS, post({ label: '  Entra  ' }));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).data).toMatchObject({ token: SECRET_TOKEN, tokenInfo: VIEW });
    const [call] = serviceCalls('mintPortalScimToken');
    expect(call!.args[0]).toEqual({ orgId: ORG_ID, label: 'Entra', actorUserId: USER_ID });
    expect(call!.outside).toBe(true);
  });

  it.each([
    ['PORTAL_SCIM_TENANT_NOT_PROVEN', 409],
    ['PORTAL_SCIM_TOKEN_LIMIT', 409],
  ] as const)('maps %s to %i', async (code, status) => {
    h.impls.mintPortalScimToken = async () => { throw new PortalScimTokenError(code, status, 'refused'); };
    const res = await makeApp().request(TOKENS, post({ label: 'x' }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'refused', code });
  });

  it.each([
    ['an empty label', { label: '   ' }],
    ['an over-long label', { label: 'x'.repeat(101) }],
    ['an extra field', { label: 'x', orgId: OTHER_ORG_ID }],
  ])('refuses %s with 400 and never mints', async (_label, body) => {
    expect((await makeApp().request(TOKENS, post(body))).status).toBe(400);
    expect(serviceCalls('mintPortalScimToken')).toEqual([]);
  });
});

describe('DELETE /organizations/:id/portal-scim/tokens/:tokenId', () => {
  it('revokes by org and token id: 204', async () => {
    const res = await makeApp().request(ONE, del());
    expect(res.status).toBe(204);
    expect(serviceCalls('revokePortalScimToken')[0]!.args[0]).toEqual({ orgId: ORG_ID, tokenId: TOKEN_ID, actorUserId: USER_ID });
  });

  it('PORTAL_SCIM_TOKEN_NOT_FOUND is 404', async () => {
    h.impls.revokePortalScimToken = async () => { throw new PortalScimTokenError('PORTAL_SCIM_TOKEN_NOT_FOUND', 404, 'Provisioning token not found.'); };
    const res = await makeApp().request(ONE, del());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PORTAL_SCIM_TOKEN_NOT_FOUND' });
  });
});

describe('gates', () => {
  const routes = (app: Hono) => [
    () => app.request(BASE),
    () => app.request(TOKENS, post({ label: 'x' })),
    () => app.request(ONE, del()),
  ];

  it('an org-scope token is refused on every route (partner|system only)', async () => {
    h.authRef.current = ORG_TOKEN;
    for (const call of routes(makeApp())) expect((await call()).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('a partner user without access to the org gets a non-leaking 404 and no service call', async () => {
    h.authRef.current = SELECTED;
    for (const call of routes(makeApp())) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(h.calls).toEqual([]);
  });

  it('mint and revoke need ORGS_WRITE and MFA; the status needs ORGS_READ', async () => {
    h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:read'] };
    const app = makeApp();
    expect((await app.request(BASE)).status).toBe(200);
    expect((await app.request(TOKENS, post({ label: 'x' }))).status).toBe(403);
    expect((await app.request(ONE, del())).status).toBe(403);
    h.authRef.current = { ...FULL_ADMIN, mfa: false };
    expect((await makeApp().request(TOKENS, post({ label: 'x' }))).status).toBe(403);
    expect((await makeApp().request(ONE, del())).status).toBe(403);
    expect(serviceCalls('mintPortalScimToken')).toEqual([]);
    expect(serviceCalls('revokePortalScimToken')).toEqual([]);
  });

  it('no auth is 401', async () => {
    h.authRef.current = null;
    expect((await makeApp().request(BASE)).status).toBe(401);
  });
});
