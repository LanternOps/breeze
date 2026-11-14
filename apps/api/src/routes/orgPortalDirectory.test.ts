import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route tests for the MSP directory-deprovisioning routes (portal registration
 * W8 #11385, plan Task 8; D7, D8, D9, OD3). The services are mocked — their
 * behaviour, audits included, is proven in services/portalDirectory/*.test.ts
 * and the W8 integration suite. These pin the gates, the org check, the body
 * validation, the context rule (every service call runs outside the request's
 * DB context) and the refusal mapping.
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
  return { store, db, ctx, calls, impls, record, authRef: { current: null as any }, routeAuditSpy: vi.fn() };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!h.authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', h.authRef.current);
    await next();
  }),
  // Real-shaped gates: each denies when the stub auth lacks what it checks.
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
  writeRouteAudit: (...args: unknown[]) => h.routeAuditSpy(...args),
}));

vi.mock('../services/portalDirectory', () => {
  class PortalDirectoryIdentityError extends Error {
    constructor(readonly code: string, readonly httpStatus: 404 | 409, message: string) {
      super(message);
      this.name = 'PortalDirectoryIdentityError';
    }
  }
  return {
    PortalDirectoryIdentityError,
    getPortalDirectoryStatus: h.record('getPortalDirectoryStatus'),
    applyRun: h.record('applyRun'),
    dismissHeldRun: h.record('dismissHeldRun'),
    restorePortalIdentity: h.record('restorePortalIdentity'),
    removeDisabledPortalIdentity: h.record('removeDisabledPortalIdentity'),
  };
});

import { authMiddleware } from '../middleware/auth';
import { PortalDirectoryIdentityError, type PortalDirectoryIdentityErrorCode } from '../services/portalDirectory';
import { registerOrgPortalDirectoryRoutes } from './orgPortalDirectory';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '7c0a1f7e-9999-4222-8333-444455556666';
const PARTNER_ID = '5d0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const RUN_ID = '22222222-3333-4444-8555-666677778888';
const PU_ID = '33333333-4444-4555-8666-777788889999';
const IDN_ID = '44444444-5555-4666-8777-88889999aaaa';
const DIGEST = 'a'.repeat(64);

const BASE = `/organizations/${ORG_ID}/portal-directory`;
const APPLY = `${BASE}/runs/${RUN_ID}/apply`;
const DISMISS = `${BASE}/runs/${RUN_ID}/dismiss`;
const IDENTITY = `/organizations/${ORG_ID}/portal-users/${PU_ID}/identities/${IDN_ID}`;
const RESTORE = `${IDENTITY}/restore`;

const FULL_ADMIN = {
  scope: 'partner',
  user: { id: USER_ID, email: 'tess@msp.example' },
  partnerId: PARTNER_ID,
  orgId: null,
  partnerOrgAccess: 'all',
  canAccessOrg: (_id: string) => true,
};
const SELECTED = { ...FULL_ADMIN, partnerOrgAccess: 'selected', canAccessOrg: (id: string) => id === OTHER_ORG_ID };
const ORG_TOKEN = {
  scope: 'organization',
  user: { id: USER_ID, email: 'owner@customer.example' },
  partnerId: PARTNER_ID,
  orgId: ORG_ID,
  canAccessOrg: (id: string) => id === ORG_ID,
};

const STATUS = {
  mode: 'enforce',
  sources: [
    { source: 'entra', lastRun: null, lastEvaluatedRun: null },
    { source: 'google', lastRun: null, lastEvaluatedRun: null },
  ],
  openActions: [{ id: 'act-1', rearmed: false }, { id: null, rearmed: true }],
};

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgPortalDirectoryRoutes(app);
  return app;
}

function post(body?: unknown) {
  return body === undefined
    ? { method: 'POST' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const del = () => ({ method: 'DELETE' });

function serviceCalls(fn: string) {
  return h.calls.filter((c) => c.fn === fn);
}

function everyRoute(app: Hono) {
  return [
    () => app.request(BASE),
    () => app.request(APPLY, post({ impactDigest: DIGEST })),
    () => app.request(DISMISS, post({ impactDigest: DIGEST })),
    () => app.request(RESTORE, post({ reactivateAccount: false })),
    () => app.request(IDENTITY, del()),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authRef.current = FULL_ADMIN;
  h.store.orgs = [{ id: ORG_ID, partnerId: PARTNER_ID }];
  h.calls.length = 0;
  h.ctx.outsideDepth = 0;
  h.impls.getPortalDirectoryStatus = async () => STATUS;
  h.impls.applyRun = async () => ({ applied: 2, skipped: 1 });
  h.impls.dismissHeldRun = async () => undefined;
  h.impls.restorePortalIdentity = async () => ({ accountStatus: 'active', blockersCleared: ['entra_directory'] });
  h.impls.removeDisabledPortalIdentity = async () => ({ identityId: IDN_ID, provider: 'entra', blockers: ['entra_directory'] });
});

describe('gates', () => {
  it('an organization-scope token is refused on every route', async () => {
    h.authRef.current = ORG_TOKEN;
    for (const call of everyRoute(makeApp())) expect((await call()).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('apply and dismiss need ORGS_WRITE and MFA, carry the digest, and audit organization.portal_directory.run.*', async () => {
    const app = makeApp();
    // Read-only partner user: the status reads, no write does.
    h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:read'] };
    expect((await app.request(BASE)).status).toBe(200);
    for (const call of everyRoute(app).slice(1)) expect((await call()).status).toBe(403);
    // No MFA: every write is refused.
    h.authRef.current = { ...FULL_ADMIN, mfa: false };
    for (const call of everyRoute(app).slice(1)) expect((await call()).status).toBe(403);
    // No permission at all: the read is refused too.
    h.authRef.current = { ...FULL_ADMIN, perms: [] };
    expect((await app.request(BASE)).status).toBe(403);
    expect(h.calls.map((c) => c.fn)).toEqual(['getPortalDirectoryStatus']);

    h.authRef.current = FULL_ADMIN;
    const applied = await app.request(APPLY, post({ impactDigest: DIGEST }));
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ data: { applied: 2, skipped: 1 } });
    expect(serviceCalls('applyRun')).toEqual([
      { fn: 'applyRun', args: [{ orgId: ORG_ID, runId: RUN_ID, actor: { userId: USER_ID, impactDigest: DIGEST } }], outside: true },
    ]);

    const dismissed = await app.request(DISMISS, post({ impactDigest: DIGEST }));
    expect(dismissed.status).toBe(204);
    expect(await dismissed.text()).toBe('');
    expect(serviceCalls('dismissHeldRun')).toEqual([
      { fn: 'dismissHeldRun', args: [{ orgId: ORG_ID, runId: RUN_ID, actorUserId: USER_ID, impactDigest: DIGEST }], outside: true },
    ]);
    // The services write organization.portal_directory.run.apply / .dismiss in
    // the decision's own transaction (runDecisions.ts); the route never writes
    // a second row.
    expect(h.routeAuditSpy).not.toHaveBeenCalled();
  });

  it('apply and dismiss refuse a body without a well-formed digest', async () => {
    const app = makeApp();
    for (const body of [undefined, {}, { impactDigest: 'short' }, { impactDigest: DIGEST.toUpperCase() }, { impactDigest: DIGEST, extra: 1 }]) {
      expect((await app.request(APPLY, post(body))).status).toBe(400);
      expect((await app.request(DISMISS, post(body))).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });
});

describe('org access', () => {
  it('apply on another org\'s run is 404', async () => {
    // The org itself is not the caller's: 404 before any service call.
    h.authRef.current = SELECTED;
    for (const call of everyRoute(makeApp())) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(h.calls).toEqual([]);

    // The org is the caller's but the run is not this org's: the service
    // scopes the run by org and refuses with its typed 404.
    h.authRef.current = FULL_ADMIN;
    h.impls.applyRun = async () => {
      throw new PortalDirectoryIdentityError('PORTAL_DIRECTORY_RUN_NOT_FOUND', 404, 'Directory run not found.');
    };
    const res = await makeApp().request(APPLY, post({ impactDigest: DIGEST }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Directory run not found.', code: 'PORTAL_DIRECTORY_RUN_NOT_FOUND' });
    expect(serviceCalls('applyRun')[0]!.args[0]).toMatchObject({ orgId: ORG_ID });
  });

  it('a missing org is 404 on every route', async () => {
    h.store.orgs = [];
    for (const call of everyRoute(makeApp())) expect((await call()).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe('GET /organizations/:id/portal-directory', () => {
  it('returns the status read outside the request context', async () => {
    const res = await makeApp().request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: STATUS });
    expect(serviceCalls('getPortalDirectoryStatus')).toEqual([{ fn: 'getPortalDirectoryStatus', args: [ORG_ID], outside: true }]);
  });
});

describe('refusals', () => {
  it('system-scope readers run through runOutsideDbContext; refusals are caught outside withDbTransaction', async () => {
    const cases: Array<[string, PortalDirectoryIdentityErrorCode, 404 | 409, () => Response | Promise<Response>]> = [
      ['applyRun', 'PORTAL_DIRECTORY_RUN_STALE', 409, () => makeApp().request(APPLY, post({ impactDigest: DIGEST }))],
      ['applyRun', 'PORTAL_DIRECTORY_RUN_NOT_HELD', 409, () => makeApp().request(APPLY, post({ impactDigest: DIGEST }))],
      ['applyRun', 'PORTAL_DIRECTORY_ENFORCEMENT_OFF', 409, () => makeApp().request(APPLY, post({ impactDigest: DIGEST }))],
      ['dismissHeldRun', 'PORTAL_DIRECTORY_ENFORCEMENT_OFF', 409, () => makeApp().request(DISMISS, post({ impactDigest: DIGEST }))],
      ['dismissHeldRun', 'PORTAL_DIRECTORY_RUN_NOT_FOUND', 404, () => makeApp().request(DISMISS, post({ impactDigest: DIGEST }))],
      ['restorePortalIdentity', 'PORTAL_IDENTITY_NOT_FOUND', 404, () => makeApp().request(RESTORE, post({ reactivateAccount: true }))],
      ['removeDisabledPortalIdentity', 'PORTAL_IDENTITY_NOT_DIRECTORY_DISABLED', 409, () => makeApp().request(IDENTITY, del())],
      ['removeDisabledPortalIdentity', 'PORTAL_IDENTITY_NOT_FOUND', 404, () => makeApp().request(IDENTITY, del())],
    ];
    for (const [fn, code, httpStatus, send] of cases) {
      h.impls[fn] = async () => {
        throw new PortalDirectoryIdentityError(code, httpStatus, `refused: ${code}`);
      };
      const res = await send();
      expect(res.status, code).toBe(httpStatus);
      expect(await res.json()).toEqual({ error: `refused: ${code}`, code });
    }
    // Every service call ran on its own system-scope connection.
    expect(h.calls.length).toBe(cases.length);
    expect(h.calls.every((c) => c.outside)).toBe(true);
  });

  it('an unexpected error is not swallowed into a 4xx', async () => {
    h.impls.applyRun = async () => {
      throw new Error('boom');
    };
    const res = await makeApp().request(APPLY, post({ impactDigest: DIGEST }));
    expect(res.status).toBe(500);
  });
});

describe('POST …/identities/:identityId/restore', () => {
  it('restore clears every blocker and needs explicit reactivation for an MSP-disabled account', async () => {
    const app = makeApp();
    h.impls.restorePortalIdentity = async () => ({ accountStatus: 'active', blockersCleared: ['entra_directory', 'scim'] });
    const res = await app.request(RESTORE, post({ reactivateAccount: true, confirmMspDisabled: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { accountStatus: 'active', blockersCleared: ['entra_directory', 'scim'] } });
    expect(serviceCalls('restorePortalIdentity')).toEqual([{
      fn: 'restorePortalIdentity',
      args: [{ orgId: ORG_ID, portalUserId: PU_ID, identityId: IDN_ID, reactivateAccount: true, confirmMspDisabled: true, actorUserId: USER_ID }],
      outside: true,
    }]);

    // confirmMspDisabled defaults to false; the service refuses an MSP-disabled account without it.
    h.calls.length = 0;
    h.impls.restorePortalIdentity = async () => {
      throw new PortalDirectoryIdentityError('PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM', 409, 'Confirm.');
    };
    const refused = await app.request(RESTORE, post({ reactivateAccount: true }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'Confirm.', code: 'PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM' });
    expect(serviceCalls('restorePortalIdentity')[0]!.args[0]).toMatchObject({ reactivateAccount: true, confirmMspDisabled: false });
    expect(h.routeAuditSpy).not.toHaveBeenCalled();
  });

  it('restore of an enabled identity is PORTAL_IDENTITY_NOT_DISABLED', async () => {
    h.impls.restorePortalIdentity = async () => {
      throw new PortalDirectoryIdentityError('PORTAL_IDENTITY_NOT_DISABLED', 409, 'This sign-in method is not disabled.');
    };
    const res = await makeApp().request(RESTORE, post({ reactivateAccount: false }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This sign-in method is not disabled.', code: 'PORTAL_IDENTITY_NOT_DISABLED' });
  });

  it('restore needs an explicit reactivateAccount boolean', async () => {
    const app = makeApp();
    for (const body of [undefined, {}, { reactivateAccount: 'yes' }, { reactivateAccount: true, confirmMspDisabled: 'yes' }, { reactivateAccount: false, extra: 1 }]) {
      expect((await app.request(RESTORE, post(body))).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });
});

describe('DELETE …/identities/:identityId (OD3)', () => {
  it('removes one directory-disabled identity through the service, outside the request context', async () => {
    const res = await makeApp().request(IDENTITY, del());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { identityId: IDN_ID, provider: 'entra', blockers: ['entra_directory'] } });
    expect(serviceCalls('removeDisabledPortalIdentity')).toEqual([{
      fn: 'removeDisabledPortalIdentity',
      args: [{ orgId: ORG_ID, portalUserId: PU_ID, identityId: IDN_ID, actorUserId: USER_ID }],
      outside: true,
    }]);
    // The service audits organization.portal_user.identity.remove itself.
    expect(h.routeAuditSpy).not.toHaveBeenCalled();
  });
});
