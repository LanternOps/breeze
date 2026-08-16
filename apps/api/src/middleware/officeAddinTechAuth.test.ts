import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mocks (vi.mock factories are hoisted — literals only) ────────────────────

const {
  redisMock,
  getRedisMock,
  getTechSessionMock,
  revokeTechSessionsForUserMock,
  findActiveBindingByIdMock,
  revokeBindingMock,
  assertActiveTenantContextMock,
  TenantInactiveErrorClass,
  computeAccessibleOrgIdsMock,
  getUserPermissionsMock,
  ipAllowlistGuardMock,
  withDbAccessContextMock,
} = vi.hoisted(() => {
  class TenantInactiveErrorClass extends Error {}
  return {
    redisMock: { del: vi.fn(() => Promise.resolve(1)) },
    getRedisMock: vi.fn(),
    getTechSessionMock: vi.fn(),
    revokeTechSessionsForUserMock: vi.fn(() => Promise.resolve()),
    findActiveBindingByIdMock: vi.fn(),
    revokeBindingMock: vi.fn(() => Promise.resolve()),
    assertActiveTenantContextMock: vi.fn(() => Promise.resolve()),
    TenantInactiveErrorClass,
    computeAccessibleOrgIdsMock: vi.fn(),
    getUserPermissionsMock: vi.fn(),
    ipAllowlistGuardMock: vi.fn(),
    withDbAccessContextMock: vi.fn(),
  };
});

vi.mock('../services/redis', () => ({ getRedis: getRedisMock }));

vi.mock('../services/officeAddin/techSession', () => ({
  getTechSession: getTechSessionMock,
  revokeTechSessionsForUser: revokeTechSessionsForUserMock,
  TECH_SESSION_KEYS: {
    session: (token: string) => `techaddin:session:${token}`,
    userSessions: (userId: string) => `techaddin:user-sessions:${userId}`,
  },
}));

vi.mock('../services/officeAddin/officeAddinBindings', async (importOriginal) => ({
  findActiveBindingById: findActiveBindingByIdMock,
  revokeBinding: revokeBindingMock,
  // The middleware branches on the REAL vetBinding — pure logic, safe to use.
  vetBinding: (await importOriginal<typeof import('../services/officeAddin/officeAddinBindings')>())
    .vetBinding,
}));

vi.mock('../services/tenantStatus', () => ({
  assertActiveTenantContext: assertActiveTenantContextMock,
  TenantInactiveError: TenantInactiveErrorClass,
}));

vi.mock('../db', () => ({
  // `db` is unused by the middleware but imported (at module load) by the real
  // officeAddinBindings module pulled in for vetBinding above.
  db: {},
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: withDbAccessContextMock,
}));

vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  return {
    ...actual,
    computeAccessibleOrgIds: computeAccessibleOrgIdsMock,
  };
});

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: getUserPermissionsMock,
  };
});

vi.mock('./ipAllowlistGuard', () => ({ ipAllowlistGuard: ipAllowlistGuardMock }));

import { officeAddinTechAuthMiddleware, requireAddinCapability } from './officeAddinTechAuth';
import { PERMISSIONS } from '../services/permissions';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TOKEN = 'opaque-tech-token';
const USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const PARTNER_ID = 'a1a1a1a1-1111-4222-8333-444455556666';
const OTHER_PARTNER_ID = 'b2b2b2b2-1111-4222-8333-444455556666';
const BINDING_ID = 'c0c0c0c0-1111-4222-8333-444455556666';
const ORG_IDS = ['org-1', 'org-2'];

const SESSION = {
  userId: USER_ID,
  partnerId: PARTNER_ID,
  bindingId: BINDING_ID,
  createdAt: new Date().toISOString(),
};

const BOUND = {
  binding: {
    id: BINDING_ID,
    userId: USER_ID,
    partnerId: PARTNER_ID,
    boundAuthEpoch: 3,
    mfaVerifiedAt: new Date(),
  },
  user: {
    id: USER_ID,
    email: 'tech@msp.example.com',
    name: 'Tech User',
    status: 'active',
    authEpoch: 3,
    partnerId: PARTNER_ID,
  },
};

const PERMS = (grants: Array<{ resource: string; action: string }>) => ({
  permissions: grants,
  partnerId: PARTNER_ID,
  orgId: null,
  roleId: 'role-1',
  scope: 'partner' as const,
  allowedSiteIds: undefined,
});

const ALL_PERMS = PERMS([
  PERMISSIONS.TICKETS_READ,
  PERMISSIONS.TICKETS_WRITE,
  PERMISSIONS.TIME_ENTRIES_READ,
  PERMISSIONS.TIME_ENTRIES_WRITE,
]);

function buildApp(extra?: (app: Hono) => void) {
  const app = new Hono();
  app.use('*', officeAddinTechAuthMiddleware);
  if (extra) extra(app);
  app.get('/ping', (c) => c.json({ ok: true, auth: c.get('officeAddinAuth') }));
  return app;
}

const authed = (path = '/ping') =>
  new Request(`http://local${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock);
  getTechSessionMock.mockResolvedValue(SESSION);
  findActiveBindingByIdMock.mockResolvedValue(BOUND);
  assertActiveTenantContextMock.mockResolvedValue(undefined);
  computeAccessibleOrgIdsMock.mockResolvedValue({ orgIds: ORG_IDS, partnerOrgAccess: 'all' });
  getUserPermissionsMock.mockResolvedValue(ALL_PERMS);
  ipAllowlistGuardMock.mockImplementation((_c: unknown, next: () => unknown) => next());
  withDbAccessContextMock.mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
});

describe('officeAddinTechAuthMiddleware', () => {
  it('401s with no Authorization header', async () => {
    const res = await buildApp().request('http://local/ping');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(getTechSessionMock).not.toHaveBeenCalled();
  });

  it('401s on a garbage (non-Bearer) Authorization header', async () => {
    const res = await buildApp().request(
      new Request('http://local/ping', { headers: { Authorization: 'Basic abc' } })
    );
    expect(res.status).toBe(401);
    expect(getTechSessionMock).not.toHaveBeenCalled();
  });

  it('does not accept a ?token= query fallback', async () => {
    const res = await buildApp().request(`http://local/ping?token=${TOKEN}`);
    expect(res.status).toBe(401);
    expect(getTechSessionMock).not.toHaveBeenCalled();
  });

  it('401s when the session is missing/expired', async () => {
    getTechSessionMock.mockResolvedValue(null);
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
    expect(getTechSessionMock).toHaveBeenCalledWith(redisMock, TOKEN);
    expect(findActiveBindingByIdMock).not.toHaveBeenCalled();
  });

  it('401s and deletes the session when the binding was revoked since mint', async () => {
    findActiveBindingByIdMock.mockResolvedValue(null);
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
    expect(redisMock.del).toHaveBeenCalledWith(`techaddin:session:${TOKEN}`);
  });

  it('401s when the session userId disagrees with the binding userId', async () => {
    const OTHER_USER_ID = 'dddddddd-1111-4222-8333-444455556666';
    findActiveBindingByIdMock.mockResolvedValue({
      binding: { ...BOUND.binding, userId: OTHER_USER_ID },
      user: { ...BOUND.user, id: OTHER_USER_ID },
    });
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
    // Confused deputy: must never vet one identity and authorize another.
    expect(computeAccessibleOrgIdsMock).not.toHaveBeenCalled();
    expect(getUserPermissionsMock).not.toHaveBeenCalled();
  });

  it('401s when the session partnerId disagrees with the binding partnerId', async () => {
    findActiveBindingByIdMock.mockResolvedValue({
      ...BOUND,
      binding: { ...BOUND.binding, partnerId: OTHER_PARTNER_ID },
      user: { ...BOUND.user, partnerId: OTHER_PARTNER_ID },
    });
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
    // Same confused-deputy posture as the userId check: a forged/stale session
    // partner claim must never be honoured, even against a consistent binding.
    expect(computeAccessibleOrgIdsMock).not.toHaveBeenCalled();
  });

  it('401s when the user was deactivated mid-session', async () => {
    findActiveBindingByIdMock.mockResolvedValue({
      ...BOUND,
      user: { ...BOUND.user, status: 'suspended' },
    });
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
    expect(computeAccessibleOrgIdsMock).not.toHaveBeenCalled();
  });

  it('401s, revokes the binding and all sessions when authEpoch advanced', async () => {
    findActiveBindingByIdMock.mockResolvedValue({
      ...BOUND,
      user: { ...BOUND.user, authEpoch: 4 },
    });
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
    expect(revokeBindingMock).toHaveBeenCalledWith(BINDING_ID, null);
    expect(revokeTechSessionsForUserMock).toHaveBeenCalledWith(redisMock, USER_ID);
  });

  it('401s when the user moved to a different partner than the session claims', async () => {
    findActiveBindingByIdMock.mockResolvedValue({
      ...BOUND,
      user: { ...BOUND.user, partnerId: OTHER_PARTNER_ID },
    });
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
  });

  it('403s when the partner tenant is inactive', async () => {
    assertActiveTenantContextMock.mockRejectedValue(new TenantInactiveErrorClass('nope'));
    const res = await buildApp().request(authed());
    expect(res.status).toBe(403);
  });

  it('401s when partner membership was removed (partnerOrgAccess null)', async () => {
    computeAccessibleOrgIdsMock.mockResolvedValue({ orgIds: [], partnerOrgAccess: null });
    const res = await buildApp().request(authed());
    expect(res.status).toBe(401);
  });

  it('happy path: populates officeAddinAuth and opens a partner-scope DB context', async () => {
    const res = await buildApp().request(authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: Record<string, unknown> };
    expect(body.auth).toMatchObject({
      userId: USER_ID,
      partnerId: PARTNER_ID,
      bindingId: BINDING_ID,
      token: TOKEN,
      user: { email: 'tech@msp.example.com', name: 'Tech User' },
      accessibleOrgIds: ORG_IDS,
      partnerOrgAccess: 'all',
    });

    // Sliding TTL is owned by getTechSession — assert it ran for this token.
    expect(getTechSessionMock).toHaveBeenCalledWith(redisMock, TOKEN);

    expect(assertActiveTenantContextMock).toHaveBeenCalledWith({
      scope: 'partner',
      partnerId: PARTNER_ID,
      orgId: null,
    });
    expect(computeAccessibleOrgIdsMock).toHaveBeenCalledWith('partner', PARTNER_ID, null, USER_ID);
    expect(getUserPermissionsMock).toHaveBeenCalledWith(USER_ID, { partnerId: PARTNER_ID });

    const ctx = withDbAccessContextMock.mock.calls[0]?.[0];
    expect(ctx).toMatchObject({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: ORG_IDS,
      accessiblePartnerIds: [PARTNER_ID],
      userId: USER_ID,
      currentPartnerId: PARTNER_ID,
    });
  });

  it('exposes working canAccessOrg / canAccessSite closures', async () => {
    getUserPermissionsMock.mockResolvedValue({ ...ALL_PERMS, allowedSiteIds: ['site-1'] });
    const app = new Hono();
    app.use('*', officeAddinTechAuthMiddleware);
    app.get('/closures', (c) => {
      const a = c.get('officeAddinAuth');
      return c.json({
        inOrg: a.canAccessOrg('org-1'),
        outOrg: a.canAccessOrg('org-999'),
        inSite: a.canAccessSite('site-1'),
        outSite: a.canAccessSite('site-2'),
      });
    });
    const res = await app.request(new Request('http://local/closures', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }));
    expect(await res.json()).toEqual({ inOrg: true, outOrg: false, inSite: true, outSite: false });
  });

  it('returns the ipAllowlistGuard response instead of swallowing it', async () => {
    ipAllowlistGuardMock.mockImplementation((c: { json: (b: unknown, s: number) => Response }) =>
      c.json({ code: 'ip_not_allowed', error: 'Access denied from this IP address' }, 403)
    );
    const res = await buildApp().request(authed());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ip_not_allowed' });
  });

  it('gives ipAllowlistGuard the tech session partner identity (no allowlist bypass)', async () => {
    await buildApp().request(authed());
    const identity = ipAllowlistGuardMock.mock.calls[0]?.[2];
    expect(identity).toMatchObject({
      partnerId: PARTNER_ID,
      isPlatformAdmin: false,
      actorId: USER_ID,
      actorEmail: 'tech@msp.example.com',
    });
  });

  it('503s when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null);
    const res = await buildApp().request(authed());
    expect(res.status).toBe(503);
  });
});

describe('requireAddinCapability', () => {
  const capApp = (cap: Parameters<typeof requireAddinCapability>[0]) => {
    const app = new Hono();
    app.use('*', officeAddinTechAuthMiddleware);
    app.use('*', requireAddinCapability(cap));
    app.get('/ping', (c) => c.json({ ok: true }));
    return app;
  };

  it('allows when live RBAC carries the mapped permission', async () => {
    const res = await capApp('ticket-create').request(authed());
    expect(res.status).toBe(200);
  });

  it('403s ticket-create when live RBAC lacks tickets:write', async () => {
    getUserPermissionsMock.mockResolvedValue(PERMS([PERMISSIONS.TICKETS_READ]));
    const res = await capApp('ticket-create').request(authed());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('403s time-write when live RBAC only carries time_entries:read', async () => {
    getUserPermissionsMock.mockResolvedValue(PERMS([PERMISSIONS.TIME_ENTRIES_READ]));
    const res = await capApp('time-write').request(authed());
    expect(res.status).toBe(403);
  });

  it('allows email-context with only tickets:read', async () => {
    getUserPermissionsMock.mockResolvedValue(PERMS([PERMISSIONS.TICKETS_READ]));
    const res = await capApp('email-context').request(authed());
    expect(res.status).toBe(200);
  });

  it('401s when no officeAddinAuth is on the context', async () => {
    const app = new Hono();
    app.use('*', requireAddinCapability('ticket-link'));
    app.get('/ping', (c) => c.json({ ok: true }));
    const res = await app.request('http://local/ping');
    expect(res.status).toBe(401);
  });
});
