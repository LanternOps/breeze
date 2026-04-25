import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const mocks = vi.hoisted(() => ({
  auth: {} as any,
  select: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  revokeJti: vi.fn(async () => undefined),
  // revokeGrant is called in addition to revokeJti so that revoking a
  // connected app immediately kills every in-flight access JWT minted from
  // the same Grant (without waiting for natural 10-minute expiry).
  revokeGrant: vi.fn(async () => undefined),
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
  db: { select: mocks.select, update: mocks.update, delete: mocks.delete },
}));

vi.mock('../oauth/revocationCache', () => ({
  revokeJti: mocks.revokeJti,
  revokeGrant: mocks.revokeGrant,
}));

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

async function loadApp(enabled = true) {
  process.env.MCP_OAUTH_ENABLED = enabled ? 'true' : 'false';
  vi.resetModules();
  const { connectedAppsRoutes } = await import('./connectedApps');
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
    resetAuth();
  });

  afterEach(() => {
    delete process.env.MCP_OAUTH_ENABLED;
  });

  it('returns 403 when auth has no partner scope', async () => {
    resetAuth(null);
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps');
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
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps');
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
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps');
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

    const res = await (await loadApp()).request('/api/v1/settings/connected-apps');

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
    await (await loadApp()).request('/api/v1/settings/connected-apps');
    // After the H2 proper fix, the partner filter is on
    // `oauth_client_partner_grants.partner_id`, not `oauth_clients.partner_id`.
    expect(mocks.eq).toHaveBeenCalledWith(expect.objectContaining({ name: 'partner_id' }), 'current-partner');
  });

  it('DELETE returns 403 when auth has no partner scope and skips DB calls', async () => {
    resetAuth(null);
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
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
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-missing', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when deleting a client where another partner has the join row', async () => {
    queueSelect([], 'limit');
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/other-client', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(mocks.eq).toHaveBeenCalledWith(expect.objectContaining({ name: 'partner_id' }), 'current-partner');
  });

  it('removes the join row, revokes refresh tokens, and cache-revokes token jtis', async () => {
    // Fix for H2 follow-up: deleting a connected app must NOT disable the
    // shared `oauth_clients` row (other partners may still rely on it).
    // Instead, drop this partner's join row and revoke this partner's
    // refresh tokens.
    queueSelect([{ clientId: 'client-1', partnerId: 'current-partner' }], 'limit');
    const joinDelete = queueDelete();
    queueSelect([
      { id: 'rt-1', payload: { jti: 'jti-1' }, expiresAt: new Date(Date.now() + 60_000) },
      { id: 'rt-2', payload: {}, expiresAt: new Date(Date.now() + 60_000) },
      { id: 'rt-3', payload: { jti: 'jti-3' }, expiresAt: new Date(Date.now() - 60_000) },
    ]);
    const revokeUpdate1 = queueUpdate();
    const revokeUpdate2 = queueUpdate();
    const revokeUpdate3 = queueUpdate();

    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    // No update on oauth_clients — the row stays for other partners.
    expect(mocks.update).toHaveBeenCalledTimes(3); // 3 refresh-token revokes only
    expect(joinDelete.where).toHaveBeenCalled();
    expect(revokeUpdate1.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(revokeUpdate2.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(revokeUpdate3.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(mocks.revokeJti).toHaveBeenCalledTimes(2);
    expect(mocks.revokeJti).toHaveBeenCalledWith('jti-1', expect.any(Number));
    expect(mocks.revokeJti).toHaveBeenCalledWith('jti-3', 1);
  });

  it('does not touch oauth_clients on revoke (other partners may still need the shared row)', async () => {
    // Two-partner scenario: Partner A revokes; Partner B's join row should
    // be untouched. We can't fully observe Partner B's row in this unit
    // test (mocks are scoped by call), but we CAN assert the route never
    // calls db.update against oauth_clients. The test below queues only
    // the join select + the join delete + an empty token list — if the
    // route tried to flip oauth_clients.disabled_at, mocks.update would
    // be invoked once with no queueUpdate ready (and the test would error
    // on the unmocked chain).
    queueSelect([{ clientId: 'client-1', partnerId: 'current-partner' }], 'limit');
    queueDelete();
    queueSelect([]);
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns 204 No Content for a successful delete', async () => {
    queueSelect([{ clientId: 'client-1', partnerId: 'current-partner' }], 'limit');
    queueDelete();
    queueSelect([]);
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('fails DELETE with 503 when the jti revocation cache write fails', async () => {
    // After the security-review fix, cache write failures must propagate as
    // 5xx. Silently returning 204 told the client "disconnected" while the
    // access JWT would keep validating until natural expiry (~10 min) —
    // partial revoke is a critical security gap.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.revokeJti.mockRejectedValueOnce(new Error('redis down'));
    queueSelect([{ clientId: 'client-1', partnerId: 'current-partner' }], 'limit');
    queueDelete();
    queueSelect([{ id: 'rt-1', payload: { jti: 'jti-1' }, expiresAt: new Date(Date.now() + 60_000) }]);
    queueUpdate();

    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(503);
    errorSpy.mockRestore();
  });

  it('cache-revokes the entire Grant (deduped) for every refresh token with grantId', async () => {
    // Two refresh tokens share grant-A (rotated), one is grant-B, one has
    // no grantId. We expect revokeGrant to be called exactly twice (one per
    // unique grant) — the dedup matters because rotation can produce many
    // refresh-token rows for the same grant and we don't want to thrash
    // Redis with redundant SETs.
    queueSelect([{ clientId: 'client-1', partnerId: 'current-partner' }], 'limit');
    queueDelete();
    queueSelect([
      { id: 'rt-1', payload: { jti: 'jti-1', grantId: 'grant-A' }, expiresAt: new Date(Date.now() + 60_000) },
      { id: 'rt-2', payload: { jti: 'jti-2', grantId: 'grant-A' }, expiresAt: new Date(Date.now() + 60_000) },
      { id: 'rt-3', payload: { jti: 'jti-3', grantId: 'grant-B' }, expiresAt: new Date(Date.now() + 60_000) },
      { id: 'rt-4', payload: { jti: 'jti-4' }, expiresAt: new Date(Date.now() + 60_000) },
    ]);
    queueUpdate();
    queueUpdate();
    queueUpdate();
    queueUpdate();

    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(mocks.revokeGrant).toHaveBeenCalledTimes(2);
    expect(mocks.revokeGrant).toHaveBeenCalledWith('grant-A', expect.any(Number));
    expect(mocks.revokeGrant).toHaveBeenCalledWith('grant-B', expect.any(Number));
  });

  it('does not mount routes when MCP_OAUTH_ENABLED is false', async () => {
    const res = await (await loadApp(false)).request('/api/v1/settings/connected-apps');
    expect(res.status).toBe(404);
  });
});
