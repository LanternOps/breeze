import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const mocks = vi.hoisted(() => ({
  auth: {} as any,
  select: vi.fn(),
  update: vi.fn(),
  revokeJti: vi.fn(async () => undefined),
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
  db: { select: mocks.select, update: mocks.update },
}));

vi.mock('../oauth/revocationCache', () => ({
  revokeJti: mocks.revokeJti,
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
  const from = vi.fn(() => ({ where }));
  mocks.select.mockImplementationOnce(() => ({ from }));
  return { from, where, limit };
}

function queueUpdate() {
  const where = vi.fn(async () => []);
  const set = vi.fn(() => ({ where }));
  mocks.update.mockImplementationOnce(() => ({ set }));
  return { set, where };
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
      },
      {
        clientId: 'client-2',
        metadata: {},
        createdAt: new Date('2026-04-21T12:00:00.000Z'),
        lastUsedAt: null,
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

  it('filters GET clients by partner id', async () => {
    queueSelect([]);
    await (await loadApp()).request('/api/v1/settings/connected-apps');
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
  });

  it('returns 404 when deleting a missing client', async () => {
    queueSelect([], 'limit');
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-missing', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns 404 when deleting a client owned by another partner', async () => {
    queueSelect([], 'limit');
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/other-client', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(mocks.eq).toHaveBeenCalledWith(expect.objectContaining({ name: 'partner_id' }), 'current-partner');
  });

  it('disables the client, revokes refresh tokens, and cache-revokes token jtis', async () => {
    queueSelect([{ id: 'client-1', disabledAt: null }], 'limit');
    const disableUpdate = queueUpdate();
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
    expect(disableUpdate.set).toHaveBeenCalledWith({ disabledAt: expect.any(Date) });
    expect(revokeUpdate1.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(revokeUpdate2.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(revokeUpdate3.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(mocks.revokeJti).toHaveBeenCalledTimes(2);
    expect(mocks.revokeJti).toHaveBeenCalledWith('jti-1', expect.any(Number));
    expect(mocks.revokeJti).toHaveBeenCalledWith('jti-3', 1);
  });

  it('returns 204 for an already-disabled client without updating disabled_at', async () => {
    queueSelect([{ id: 'client-1', disabledAt: new Date('2026-04-20T12:00:00.000Z') }], 'limit');
    queueSelect([]);
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns 204 No Content for a successful delete', async () => {
    queueSelect([{ id: 'client-1', disabledAt: null }], 'limit');
    queueUpdate();
    queueSelect([]);
    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('does not fail DELETE when cache jti revocation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.revokeJti.mockRejectedValueOnce(new Error('redis down'));
    queueSelect([{ id: 'client-1', disabledAt: null }], 'limit');
    queueUpdate();
    queueSelect([{ id: 'rt-1', payload: { jti: 'jti-1' }, expiresAt: new Date(Date.now() + 60_000) }]);
    const revokeUpdate = queueUpdate();

    const res = await (await loadApp()).request('/api/v1/settings/connected-apps/client-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(revokeUpdate.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(errorSpy).toHaveBeenCalledWith(
      '[oauth] connected-app revocation cache write failed',
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });

  it('does not mount routes when MCP_OAUTH_ENABLED is false', async () => {
    const res = await (await loadApp(false)).request('/api/v1/settings/connected-apps');
    expect(res.status).toBe(404);
  });
});
