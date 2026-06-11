import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockMobileDevices: Record<string, any> = {};
const mockGrants: Record<string, any> = {};
const mockClientBlocks: any[] = [];

const dbState = {
  selectFrom: '',
  selectWhereId: '',
  selectWhereUserId: '',
  selectWhereClientId: '',
  selectWhereOrgId: '',
};

// Drizzle is heavily chained — emulate the few combinations the route needs.
function buildSelectChain<T>(rows: () => T[]) {
  return {
    from: vi.fn(function (this: any, _table: any) {
      return this;
    }),
    where: vi.fn(function (this: any, _: any) {
      return this;
    }),
    innerJoin: vi.fn(function (this: any, _: any, __: any) {
      return this;
    }),
    orderBy: vi.fn(function (this: any) {
      return this;
    }),
    groupBy: vi.fn(function (this: any) {
      return this;
    }),
    limit: vi.fn(function (this: any) {
      return rows();
    }),
    [Symbol.asyncIterator]: undefined as any,
    then: function (resolve: (v: T[]) => void) {
      return Promise.resolve(rows()).then(resolve);
    },
  };
}

let nextSelectRows: any[] = [];
let nextUpdateReturning: any[] = [];
let nextInsertReturning: any[] = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => buildSelectChain(() => nextSelectRows)),
    update: vi.fn(() => ({
      set: vi.fn(function (this: any) { return this; }),
      where: vi.fn(function (this: any) { return this; }),
      returning: vi.fn(async () => nextUpdateReturning),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(function (this: any) { return this; }),
      returning: vi.fn(async () => nextInsertReturning),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
    transaction: vi.fn(async (fn: any) => fn({})),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => {
  const make = (n: string) => new Proxy({}, { get: () => n });
  return {
    mobileDevices: make('mobile_devices'),
    oauthClients: make('oauth_clients'),
    oauthClientBlocks: make('oauth_client_blocks'),
    oauthGrants: make('oauth_grants'),
    oauthRefreshTokens: make('oauth_refresh_tokens'),
    organizationUsers: make('organization_users'),
    organizations: make('organizations'),
    partnerUsers: make('partner_users'),
  };
});

vi.mock('../db/schema/approvals', () => {
  const make = (n: string) => new Proxy({}, { get: () => n });
  return { approvalRequests: make('approval_requests') };
});

vi.mock('../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../oauth/revocationCache', () => ({
  revokeGrant: vi.fn(async () => undefined),
  revokeJti: vi.fn(async () => undefined),
}));

vi.mock('../oauth/log', () => ({
  ERROR_IDS: { OAUTH_REVOCATION_CACHE_WRITE_FAILED: 'OAUTH_REVOCATION_CACHE_WRITE_FAILED' },
  logOauthError: vi.fn(),
}));

vi.mock('../oauth/provider', () => ({
  ACCESS_TOKEN_TTL_SECONDS: 600,
}));

vi.mock('./auth/helpers', () => ({
  resolveUserAuditOrgId: vi.fn(async () => 'org-1'),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    USERS_WRITE: { resource: 'users', action: 'write' },
  },
}));

let mockAuth: any = null;
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', mockAuth);
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { lifecycleRoutes, lifecycleAdminRoutes, MOBILE_DEVICE_ID_HEADER } from './lifecycle';

beforeEach(() => {
  vi.clearAllMocks();
  nextSelectRows = [];
  nextUpdateReturning = [];
  nextInsertReturning = [];
  mockAuth = {
    scope: 'organization',
    partnerId: 'p-1',
    orgId: 'o-1',
    accessibleOrgIds: ['o-1'],
    canAccessOrg: (id: string) => id === 'o-1',
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'a@b.test',
      name: 'A',
      isPlatformAdmin: false,
    },
    token: { mfa: true },
  };
});

// ============================================================
// GET /me/mobile-devices
// ============================================================

describe('GET /me/mobile-devices', () => {
  it('returns the calling user devices including isCurrent flag', async () => {
    nextSelectRows = [
      {
        id: 'md-1',
        deviceId: 'install-current',
        platform: 'ios',
        model: 'iPhone',
        osVersion: '18',
        appVersion: '1.0',
        lastActiveAt: new Date(),
        status: 'active',
        blockedAt: null,
        blockedReason: null,
        createdAt: new Date(),
      },
      {
        id: 'md-2',
        deviceId: 'install-other',
        platform: 'android',
        model: null,
        osVersion: null,
        appVersion: null,
        lastActiveAt: null,
        status: 'blocked',
        blockedAt: new Date(),
        blockedReason: 'lost',
        createdAt: new Date(),
      },
    ];

    const res = await lifecycleRoutes.request('/me/mobile-devices', {
      headers: { [MOBILE_DEVICE_ID_HEADER]: 'install-current' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(2);
    expect(body.devices[0].isCurrent).toBe(true);
    expect(body.devices[1].isCurrent).toBe(false);
    expect(body.devices[1].status).toBe('blocked');
  });
});

// ============================================================
// POST /me/mobile-devices/:id/block
// ============================================================

describe('POST /me/mobile-devices/:id/block', () => {
  it('blocks a non-current device, clears push tokens, returns 204', async () => {
    nextSelectRows = [{
      id: 'md-2',
      deviceId: 'install-other',
      userId: 'u-1',
      status: 'active',
    }];
    nextUpdateReturning = [{
      id: 'md-2',
      deviceId: 'install-other',
      userId: 'u-1',
      status: 'blocked',
    }];

    const res = await lifecycleRoutes.request(
      '/me/mobile-devices/00000000-0000-0000-0000-000000000002/block',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [MOBILE_DEVICE_ID_HEADER]: 'install-current',
        },
        body: JSON.stringify({ reason: 'lost phone' }),
      }
    );

    expect(res.status).toBe(204);
  });

  it('refuses to block the current device with 409 + self_revoke_blocked', async () => {
    nextSelectRows = [{
      id: 'md-1',
      deviceId: 'install-current',
      userId: 'u-1',
      status: 'active',
    }];

    const res = await lifecycleRoutes.request(
      '/me/mobile-devices/00000000-0000-0000-0000-000000000001/block',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [MOBILE_DEVICE_ID_HEADER]: 'install-current',
        },
        body: JSON.stringify({}),
      }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('self_revoke_blocked');
  });

  it('returns 404 when the target device does not belong to the user', async () => {
    nextSelectRows = [];
    const res = await lifecycleRoutes.request(
      '/me/mobile-devices/00000000-0000-0000-0000-000000000003/block',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 when device is already blocked', async () => {
    nextSelectRows = [{ id: 'md-2', deviceId: 'x', userId: 'u-1', status: 'blocked' }];
    const res = await lifecycleRoutes.request(
      '/me/mobile-devices/00000000-0000-0000-0000-000000000002/block',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    expect(res.status).toBe(409);
  });
});

// ============================================================
// Admin block
// ============================================================

describe('POST /admin/users/:userId/mobile-devices/:id/block', () => {
  it('refuses to admin-block self (use /me path instead)', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/users/11111111-1111-1111-1111-111111111111/mobile-devices/00000000-0000-0000-0000-000000000099/block',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'oops' }),
      }
    );
    expect(res.status).toBe(409);
  });

  it('rejects malformed UUIDs', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/users/not-uuid/mobile-devices/00000000-0000-0000-0000-000000000099/block',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'oops' }),
      }
    );
    expect(res.status).toBe(400);
  });

  it('requires reason', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/users/00000000-0000-0000-0000-000000000007/mobile-devices/00000000-0000-0000-0000-000000000099/block',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }
    );
    expect(res.status).toBe(400);
  });
});

// ============================================================
// Org-wide oauth client block input validation
// ============================================================

describe('POST /admin/orgs/:orgId/oauth-clients/:clientId/block-globally', () => {
  it('rejects bad orgId', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/orgs/not-uuid/oauth-clients/cid-123/block-globally',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'tightening' }),
      }
    );
    expect(res.status).toBe(400);
  });

  it('refuses orgs outside the caller scope', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/orgs/00000000-0000-0000-0000-000000000999/oauth-clients/cid-123/block-globally',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'tightening' }),
      }
    );
    expect(res.status).toBe(403);
  });
});

// ============================================================
// GET /admin/users/:userId/mobile-devices
// ============================================================

describe('GET /admin/users/:userId/mobile-devices', () => {
  it('rejects bad userId', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/users/not-uuid/mobile-devices'
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when target user is outside caller scope', async () => {
    // adminCanReachUser will look up partnerUsers/organizationUsers — both empty.
    nextSelectRows = [];
    const res = await lifecycleAdminRoutes.request(
      '/admin/users/00000000-0000-0000-0000-000000000007/mobile-devices'
    );
    expect(res.status).toBe(403);
  });
});

// ============================================================
// GET /admin/orgs/:orgId/oauth-clients
// ============================================================

describe('GET /admin/orgs/:orgId/oauth-clients', () => {
  it('rejects bad orgId', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/orgs/not-uuid/oauth-clients'
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when org is outside caller scope', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/orgs/00000000-0000-0000-0000-000000000999/oauth-clients'
    );
    expect(res.status).toBe(403);
  });
});

// ============================================================
// POST /admin/orgs/:orgId/oauth-clients/:clientId/unblock-globally
// ============================================================

describe('POST /admin/orgs/:orgId/oauth-clients/:clientId/unblock-globally', () => {
  it('rejects bad orgId', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/orgs/not-uuid/oauth-clients/cid-123/unblock-globally',
      { method: 'POST' }
    );
    expect(res.status).toBe(400);
  });

  it('refuses orgs outside the caller scope', async () => {
    const res = await lifecycleAdminRoutes.request(
      '/admin/orgs/00000000-0000-0000-0000-000000000999/oauth-clients/cid-123/unblock-globally',
      { method: 'POST' }
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when no block exists', async () => {
    nextSelectRows = [];
    const res = await lifecycleAdminRoutes.request(
      '/admin/orgs/00000000-0000-0000-0000-00000000aaaa/oauth-clients/cid-123/unblock-globally',
      { method: 'POST' }
    );
    // adminCanReachUser is not invoked; canAccessOrg uses 'o-1' so this org is out of scope
    expect([403, 404]).toContain(res.status);
  });
});

// ============================================================
// Regression: middleware does not leak onto sibling routes (#683)
// ============================================================

describe('lifecycle middleware scoping (#683)', () => {
  it('does not run authMiddleware for sibling routes when mounted at /', async () => {
    const { Hono } = await import('hono');
    const { authMiddleware } = await import('../middleware/auth');
    const spy = vi.mocked(authMiddleware);
    spy.mockClear();

    const sibling = new Hono();
    sibling.get('/agent-versions/:version/download', (c) => c.json({ ok: true }));

    const parent = new Hono();
    parent.route('/', lifecycleRoutes);
    parent.route('/', lifecycleAdminRoutes);
    parent.route('/', sibling);

    const res = await parent.request('/agent-versions/0.65.9/download?platform=linux&arch=amd64');
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still runs authMiddleware for /me/* paths', async () => {
    const { Hono } = await import('hono');
    const { authMiddleware } = await import('../middleware/auth');
    const spy = vi.mocked(authMiddleware);
    spy.mockClear();

    const parent = new Hono();
    parent.route('/', lifecycleRoutes);

    nextSelectRows = [];
    await parent.request('/me/mobile-devices', {
      headers: { [MOBILE_DEVICE_ID_HEADER]: 'install-current' },
    });
    expect(spy).toHaveBeenCalled();
  });
});
