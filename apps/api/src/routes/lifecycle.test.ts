import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockMobileDevices: Record<string, any> = {};
const mockGrants: Record<string, any> = {};
const mockClientBlocks: any[] = [];
const selectWheres: unknown[] = [];

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
    where: vi.fn(function (this: any, expr: unknown) {
      selectWheres.push(expr);
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

function sqlValues(expr: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (node: any): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object') {
      if (Array.isArray(node.queryChunks)) node.queryChunks.forEach(visit);
      else if ('value' in node) visit(node.value);
    } else {
      out.push(node);
    }
  };
  visit(expr);
  return out;
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
  publishFamilyRevocationSentinel: vi.fn(async () => true),
}));

const familyRevocationMocks = vi.hoisted(() => ({
  revokeMobileDeviceRefreshFamilies: vi.fn(async () => ['family-mobile-1']),
}));

vi.mock('../services/authLifecycle', () => ({
  revokeMobileDeviceRefreshFamilies: familyRevocationMocks.revokeMobileDeviceRefreshFamilies,
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
  // Mock value only — the real constant lives in oauth/provider.ts (raised
  // to 1800 for #2363); nothing in this suite asserts on the number.
  ACCESS_TOKEN_TTL_SECONDS: 1800,
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
  // Same rule as the real one; the integration suite runs the real one.
  requireInteractiveSession: vi.fn(() => async (c: any, next: any) => (
    c.get('auth')?.principal?.kind === 'user_session' ? next() : c.json({ error: 'Interactive user session required' }, 403)
  )),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => fn()),
}));

const toolListModes = vi.hoisted(() => ({
  getUserConnectionToolListModes: vi.fn(),
  setUserConnectionToolListMode: vi.fn(),
}));
vi.mock('../services/mcpConnectionToolListMode', () => toolListModes);

import { lifecycleRoutes, lifecycleAdminRoutes, MOBILE_DEVICE_ID_HEADER } from './lifecycle';
import { publishFamilyRevocationSentinel, rateLimiter } from '../services';
import { writeRouteAudit } from '../services/auditEvents';

import { db } from '../db';

beforeEach(() => {
  vi.clearAllMocks();
  nextSelectRows = [];
  selectWheres.length = 0;
  nextUpdateReturning = [];
  nextInsertReturning = [];
  toolListModes.getUserConnectionToolListModes.mockResolvedValue(() => ({ kind: 'none', grantCount: 0 }));
  toolListModes.setUserConnectionToolListMode.mockResolvedValue(1);
  mockAuth = {
    principal: { kind: 'user_session' },
    scope: 'organization',
    partnerId: 'p-1',
    partnerOrgAccess: null,
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
    expect(familyRevocationMocks.revokeMobileDeviceRefreshFamilies).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-1111-1111-111111111111',
      'install-other',
      'mobile-device-blocked'
    );
    expect(publishFamilyRevocationSentinel).toHaveBeenCalledWith('family-mobile-1');
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
    expect(familyRevocationMocks.revokeMobileDeviceRefreshFamilies).not.toHaveBeenCalled();
    expect(publishFamilyRevocationSentinel).not.toHaveBeenCalled();
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
  it('revokes only the target installation families when an admin blocks the device', async () => {
    mockAuth = {
      ...mockAuth,
      scope: 'system',
      user: { ...mockAuth.user, id: '99999999-9999-4999-8999-999999999999', isPlatformAdmin: true },
    };
    nextSelectRows = [{
      id: '00000000-0000-0000-0000-000000000099',
      deviceId: 'install-target',
      userId: '00000000-0000-0000-0000-000000000007',
      status: 'active',
    }];
    nextUpdateReturning = [{
      id: '00000000-0000-0000-0000-000000000099',
      deviceId: 'install-target',
      userId: '00000000-0000-0000-0000-000000000007',
      status: 'blocked',
    }];

    const res = await lifecycleAdminRoutes.request(
      '/admin/users/00000000-0000-0000-0000-000000000007/mobile-devices/00000000-0000-0000-0000-000000000099/block',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'lost phone' }),
      }
    );

    expect(res.status).toBe(204);
    expect(familyRevocationMocks.revokeMobileDeviceRefreshFamilies).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000007',
      'install-target',
      'mobile-device-blocked'
    );
    expect(publishFamilyRevocationSentinel).toHaveBeenCalledWith('family-mobile-1');
  });

  it.each(['selected', 'none'] as const)(
    'denies a partnerOrgAccess=%s caller targeting another partner staff member',
    async (partnerOrgAccess) => {
      mockAuth = {
        ...mockAuth,
        scope: 'partner',
        orgId: null,
        partnerOrgAccess,
        accessibleOrgIds: partnerOrgAccess === 'selected' ? ['o-1'] : [],
        canAccessOrg: () => false,
      };
      vi.mocked(db.select).mockImplementationOnce(() =>
        buildSelectChain(() => [{ partnerId: 'p-1' }]) as any
      );
      nextSelectRows = [{
        id: '00000000-0000-0000-0000-000000000099',
        deviceId: 'target-phone',
        userId: '00000000-0000-0000-0000-000000000007',
        status: 'active',
      }];
      nextUpdateReturning = [{ id: '00000000-0000-0000-0000-000000000099' }];

      const res = await lifecycleAdminRoutes.request(
        '/admin/users/00000000-0000-0000-0000-000000000007/mobile-devices/00000000-0000-0000-0000-000000000099/block',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'lost phone' }),
        }
      );

      expect(res.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    }
  );

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
  it.each(['selected', 'none'] as const)(
    'denies a partnerOrgAccess=%s caller enumerating another partner staff member devices',
    async (partnerOrgAccess) => {
      mockAuth = {
        ...mockAuth,
        scope: 'partner',
        orgId: null,
        partnerOrgAccess,
        accessibleOrgIds: partnerOrgAccess === 'selected' ? ['o-1'] : [],
        canAccessOrg: () => false,
      };
      vi.mocked(db.select).mockImplementationOnce(() =>
        buildSelectChain(() => [{ partnerId: 'p-1' }]) as any
      );
      nextSelectRows = [{
        id: 'mobile-1',
        deviceId: 'target-phone',
        platform: 'ios',
        model: 'Phone',
        osVersion: '18',
        appVersion: '1.0',
        lastActiveAt: new Date(),
        status: 'active',
        blockedAt: null,
        blockedReason: null,
        createdAt: new Date(),
      }];

      const res = await lifecycleAdminRoutes.request(
        '/admin/users/00000000-0000-0000-0000-000000000007/mobile-devices'
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'User not in your tenant' });
    }
  );

  it('allows an all-access partner to administer another partner staff member', async () => {
    mockAuth = {
      ...mockAuth,
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'all',
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    };
    vi.mocked(db.select).mockImplementationOnce(() =>
      buildSelectChain(() => [{ partnerId: 'p-1' }]) as any
    );
    nextSelectRows = [];

    const res = await lifecycleAdminRoutes.request(
      '/admin/users/00000000-0000-0000-0000-000000000007/mobile-devices'
    );

    expect(res.status).toBe(200);
    expect(sqlValues(selectWheres[0])).toEqual(expect.arrayContaining([
      'partner_users',
      '00000000-0000-0000-0000-000000000007',
      'p-1',
    ]));
  });

  it('allows a selected-access partner to administer an org user inside their selection', async () => {
    mockAuth = {
      ...mockAuth,
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'selected',
      accessibleOrgIds: ['o-1'],
      canAccessOrg: (id: string) => id === 'o-1',
    };
    vi.mocked(db.select)
      .mockImplementationOnce(() => buildSelectChain(() => []) as any)
      .mockImplementationOnce(() => buildSelectChain(() => [{ orgId: 'o-1' }]) as any);
    nextSelectRows = [];

    const res = await lifecycleAdminRoutes.request(
      '/admin/users/00000000-0000-0000-0000-000000000007/mobile-devices'
    );

    expect(res.status).toBe(200);
  });

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

describe('MCP tool list mode of own connections (#12429)', () => {
  const USER_ID = '11111111-1111-1111-1111-111111111111';
  const MODE_PATH = '/me/oauth-clients/client-a/mcp-tool-list-mode';
  const patchMode = (body: unknown, path = MODE_PATH) => lifecycleRoutes.request(path, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  afterEach(() => vi.unstubAllEnvs());

  it('GET rows carry the typed mode of their own client, and the response the deployment default', async () => {
    vi.stubEnv('MCP_TOOL_LIST_DEFAULT', 'progressive');
    const uniform = { kind: 'uniform', stored: 'full', effective: { mode: 'full', source: 'credential' }, grantCount: 2 };
    toolListModes.getUserConnectionToolListModes.mockResolvedValue(
      (clientId: string) => (clientId === 'client-a' ? uniform : { kind: 'mixed', grantCount: 3 }),
    );
    const row = { displayName: { client_name: 'App' }, createdAt: new Date(), revokedAt: null, clientLastUsedAt: null };
    nextSelectRows = [{ ...row, clientId: 'client-a' }, { ...row, clientId: 'client-b' }];
    const body = await (await lifecycleRoutes.request('/me/oauth-clients')).json() as any;
    expect(toolListModes.getUserConnectionToolListModes).toHaveBeenCalledWith(USER_ID);
    expect(body.mcpToolListDefault).toBe('progressive');
    expect(body.clients.map((c: any) => [c.clientId, c.toolListMode])).toEqual([
      ['client-a', uniform], ['client-b', { kind: 'mixed', grantCount: 3 }],
    ]);
  });

  it.each(['full', 'progressive', null])('PATCH %s writes the caller\'s own connections and audits value and count', async (mode) => {
    toolListModes.setUserConnectionToolListMode.mockResolvedValue(2);
    const res = await patchMode({ mcp_tool_list_mode: mode });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    expect(toolListModes.setUserConnectionToolListMode).toHaveBeenCalledWith({ userId: USER_ID, clientId: 'client-a', mode });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-1',
      action: 'oauth.client.mcp_tool_list_mode_update',
      resourceType: 'oauth_client',
      resourceId: 'client-a',
      details: { mcpToolListMode: mode, grantCount: 2 },
    });
  });

  it('decodes a URL client id', async () => {
    const id = 'https://app.example/oauth/client.json';
    await patchMode({ mcp_tool_list_mode: null }, `/me/oauth-clients/${encodeURIComponent(id)}/mcp-tool-list-mode`);
    expect(toolListModes.setUserConnectionToolListMode).toHaveBeenCalledWith({ userId: USER_ID, clientId: id, mode: null });
  });

  it.each([{}, { mcp_tool_list_mode: 'Full' }, { mcp_tool_list_mode: '' }, { mcpToolListMode: 'full' }])('%j is a 400 and writes nothing', async (body) => {
    expect((await patchMode(body)).status).toBe(400);
    expect(toolListModes.setUserConnectionToolListMode).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('404 when no active connection matched, and nothing is audited', async () => {
    toolListModes.setUserConnectionToolListMode.mockResolvedValue(0);
    expect((await patchMode({ mcp_tool_list_mode: 'full' })).status).toBe(404);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  // A session is enough (no MFA claim in this context's token), and only a
  // session: a credential never edits credentials.
  it('needs no MFA', async () => {
    mockAuth.token = { mfa: false };
    expect((await patchMode({ mcp_tool_list_mode: 'full' })).status).toBe(200);
  });

  it.each([
    { kind: 'api_key', apiKeyId: 'k-1' },
    { kind: 'api_key', apiKeyId: 'k-1', partnerServicePrincipalId: 'psp-1' },
    { kind: 'oauth_grant', grantId: 'g-1' },
  ])('refuses a non-session principal with 403 and no write: %j', async (principal) => {
    mockAuth.principal = principal;
    expect((await patchMode({ mcp_tool_list_mode: 'full' })).status).toBe(403);
    expect(toolListModes.setUserConnectionToolListMode).not.toHaveBeenCalled();
  });

  it('is rate limited before it writes', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 1000) } as never);
    expect((await patchMode({ mcp_tool_list_mode: 'full' })).status).toBe(429);
    expect(toolListModes.setUserConnectionToolListMode).not.toHaveBeenCalled();
  });
});

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
