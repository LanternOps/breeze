import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const mocks = vi.hoisted(() => ({
  auth: {} as any,
  select: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) =>
    fn({ update: mocks.update, delete: mocks.delete }),
  ),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  // Grant-family revocation is delegated to the central service; the route's
  // job is just authorization (join-row check), scope selection, and 503 on
  // marker-write failure. The service's own behavior is covered in
  // oauth/revocationService.test.ts + the integration suite.
  revokeClientFamilies: vi.fn(async () => ({ grants: 0, refreshTokens: 0 })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: mocks.eq, and: mocks.and };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', mocks.auth);
    await next();
  }),
}));

vi.mock('../db', () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
    delete: mocks.delete,
    transaction: mocks.transaction,
  },
  runOutsideDbContext: mocks.runOutsideDbContext,
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
}));

vi.mock('../db/schema', () => ({
  oauthClients: {
    id: { name: 'id' },
    metadata: { name: 'metadata' },
    createdAt: { name: 'created_at' },
    lastUsedAt: { name: 'last_used_at' },
    disabledAt: { name: 'disabled_at' },
  },
  oauthClientPartnerGrants: {
    clientId: { name: 'client_id' },
    partnerId: { name: 'partner_id' },
  },
}));

vi.mock('../oauth/revocationService', () => ({
  revokeClientFamilies: mocks.revokeClientFamilies,
}));

vi.mock('../config/env', () => ({ MCP_OAUTH_ENABLED: true }));

import { connectedAppsRoutes } from './connectedApps';

function resetAuth(partnerId: string | null = 'current-partner') {
  mocks.auth = {
    user: { id: 'u1', email: 'user@example.com', name: 'User One' },
    token: {},
    partnerId,
    orgId: 'current-org',
    scope: partnerId ? 'partner' : 'system',
    accessibleOrgIds: null,
    orgCondition: vi.fn(),
    canAccessOrg: vi.fn(),
  };
}

function queueSelect(rows: unknown[], mode: 'where' | 'limit' = 'where') {
  const limit = vi.fn(async () => rows);
  const where = mode === 'limit' ? vi.fn(() => ({ limit })) : vi.fn(async () => rows);
  // The GET handler uses .from(...).innerJoin(...).where(...). The DELETE
  // handler uses .from(...).where(...).limit(...) and .from(...).where(...).
  // Expose innerJoin returning the same { where } so a single helper covers
  // both shapes.
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ where, innerJoin }));
  mocks.select.mockImplementationOnce(() => ({ from }));
  return { from, where, limit, innerJoin };
}

function queueUpdate() {
  const where = vi.fn(async () => []);
  const set = vi.fn(() => ({ where }));
  mocks.update.mockImplementationOnce(() => ({ set }));
  return { set, where };
}

function queueDelete() {
  const where = vi.fn(async () => []);
  mocks.delete.mockImplementationOnce(() => ({ where }));
  return { where };
}

function loadApp() {
  const app = new Hono().route('/api/v1/settings/connected-apps', connectedAppsRoutes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ message: err.message }, err.status);
    }
    throw err;
  });
  return app;
}

describe('connectedAppsRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReset();
    mocks.update.mockReset();
    mocks.delete.mockReset();
    mocks.revokeClientFamilies.mockReset();
    mocks.revokeClientFamilies.mockResolvedValue({ grants: 0, refreshTokens: 0 });
    resetAuth();
  });

  it('returns 403 when auth has no partner scope', async () => {
    resetAuth(null);
    const res = await loadApp().request('/api/v1/settings/connected-apps');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'partner scope required' });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns a shaped client list for the caller partner', async () => {
    queueSelect([
      {
        clientId: 'client-1',
        metadata: { client_name: 'Claude Desktop', redirect_uris: ['https://secret.example/cb'] },
        createdAt: new Date('2026-04-20T12:00:00.000Z'),
        lastUsedAt: new Date('2026-04-22T12:00:00.000Z'),
        disabledAt: null,
      },
      {
        clientId: 'client-2',
        metadata: {},
        createdAt: new Date('2026-04-21T12:00:00.000Z'),
        lastUsedAt: null,
        disabledAt: null,
      },
    ]);
    const res = await loadApp().request('/api/v1/settings/connected-apps');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clients: [
        {
          client_id: 'client-1',
          client_name: 'Claude Desktop',
          created_at: '2026-04-20T12:00:00.000Z',
          last_used_at: '2026-04-22T12:00:00.000Z',
        },
        {
          client_id: 'client-2',
          client_name: 'client-2',
          created_at: '2026-04-21T12:00:00.000Z',
          last_used_at: null,
        },
      ],
    });
  });

  it('returns an empty client list', async () => {
    queueSelect([]);
    const res = await loadApp().request('/api/v1/settings/connected-apps');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clients: [] });
  });

  it('omits disabled clients from the connected app list', async () => {
    queueSelect([
      {
        clientId: 'client-1',
        metadata: { client_name: 'Revoked app' },
        createdAt: new Date('2026-04-20T12:00:00.000Z'),
        lastUsedAt: null,
        disabledAt: new Date('2026-04-23T12:00:00.000Z'),
      },
      {
        clientId: 'client-2',
        metadata: { client_name: 'Active app' },
        createdAt: new Date('2026-04-21T12:00:00.000Z'),
        lastUsedAt: null,
        disabledAt: null,
      },
    ]);

    const res = await loadApp().request('/api/v1/settings/connected-apps');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clients: [
        {
          client_id: 'client-2',
          client_name: 'Active app',
          created_at: '2026-04-21T12:00:00.000Z',
          last_used_at: null,
        },
      ],
    });
  });

  it('filters GET clients by partner id (via the join table)', async () => {
    queueSelect([]);
    await loadApp().request('/api/v1/settings/connected-apps');
    // After the H2 proper fix, the partner filter is on
    // `oauth_client_partner_grants.partner_id`, not `oauth_clients.partner_id`.
    expect(mocks.eq).toHaveBeenCalledWith(expect.objectContaining({ name: 'partner_id' }), 'current-partner');
  });

  it('DELETE returns 403 when auth has no partner scope and skips DB calls', async () => {
    resetAuth(null);
    const res = await loadApp().request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'partner scope required' });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when this partner has no join row for the client', async () => {
    // Lookup is now against oauth_client_partner_grants — a missing row means
    // either the client doesn't exist or another partner installed it but
    // this one didn't. Either way, return 404 without touching anything.
    queueSelect([], 'limit');
    const res = await loadApp().request('/api/v1/settings/connected-apps/client-missing', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when deleting a client where another partner has the join row', async () => {
    queueSelect([], 'limit');
    const res = await loadApp().request('/api/v1/settings/connected-apps/other-client', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(mocks.eq).toHaveBeenCalledWith(expect.objectContaining({ name: 'partner_id' }), 'current-partner');
  });

  it('delegates to the central service with partner scope after the join-row check', async () => {
    // The route no longer discovers/revokes families inline. It authorizes via
    // the join-row lookup, then hands off to revokeClientFamilies with PARTNER
    // scope so code-only grants are revoked and other partners on the shared
    // client are left untouched (MCP-OAUTH-07).
    queueSelect([{ clientId: 'client-1', partnerId: 'current-partner' }], 'limit');

    const res = await loadApp().request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(mocks.revokeClientFamilies).toHaveBeenCalledTimes(1);
    expect(mocks.revokeClientFamilies).toHaveBeenCalledWith('client-1', {
      kind: 'partner',
      partnerId: 'current-partner',
    });
  });

  it('does not call the revocation service when the join row is missing (404)', async () => {
    queueSelect([], 'limit');
    const res = await loadApp().request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(mocks.revokeClientFamilies).not.toHaveBeenCalled();
  });

  it('fails DELETE with 503 when the revocation service throws (fail closed)', async () => {
    // A marker-write failure inside the service must surface as 5xx. Silently
    // returning 204 would tell the client "disconnected" while access JWTs
    // keep validating until natural expiry — a partial-revoke security gap.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.revokeClientFamilies.mockRejectedValueOnce(new Error('redis down'));
    queueSelect([{ clientId: 'client-1', partnerId: 'current-partner' }], 'limit');

    const res = await loadApp().request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(503);
    errorSpy.mockRestore();
  });
});
