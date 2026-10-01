/**
 * Portal logout ends the presented session durably.
 *
 * A portal session is an opaque token cached in Redis. Deleting that cache
 * entry is not a revocation: a failed delete, a Redis restore from an older
 * snapshot, or a replica that still holds the key would leave the token
 * usable. Logout therefore records the token (as a digest) in Postgres before
 * answering, the middleware refuses any recorded token, and the cache delete
 * is only cleanup. Other sessions of the same portal user are untouched.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PORTAL_STATE_BACKEND = 'redis';
});

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  selectedColumns: [] as Array<Record<string, unknown>>,
  cache: new Map<string, string>(),
  failCleanup: false,
  dropRedisAfterAuth: false,
}));

const revokePortalSessionDurably = vi.hoisted(() => vi.fn(async (_token: string, _userId: string) => undefined));

vi.mock('../../services/portal/sessionRevocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portal/sessionRevocation')>()),
  revokePortalSessionDurably,
}));

vi.mock('../../services/portal/timezone', () => ({ resolveOrgTimezone: vi.fn(async () => 'UTC') }));

function project(columns: Record<string, unknown>): Array<Record<string, unknown>> {
  state.selectedColumns.push(columns);
  if (!state.row) return [];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(columns)) out[key] = state.row[key] ?? null;
  return [out];
}

vi.mock('../../db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(project(columns)) }) }),
    }),
  },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
vi.mock('../../db/schema', () => ({
  discoveredAssetTypeEnum: { enumValues: [] },
  portalUsers: {
    id: 'id',
    orgId: 'orgId',
    email: 'email',
    name: 'name',
    contactId: 'contactId',
    receiveNotifications: 'receiveNotifications',
    status: 'status',
  },
  portalBranding: { orgId: 'orgId', enablePasswordReset: 'enablePasswordReset' },
}));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({ orgId: ORG_ID, partnerId: 'partner-1' })),
  isUsableOrgStatus: (s: string) => s === 'active' || s === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

function fakeRedis() {
  const cleanup = async <T,>(value: T): Promise<T> => {
    if (state.failCleanup) throw new Error('synthetic Redis write fault');
    return value;
  };
  const chain = () => {
    const ops: Array<() => Promise<unknown>> = [];
    const api = {
      del: (key: string) => { ops.push(() => cleanup(state.cache.delete(key))); return api; },
      srem: () => { ops.push(() => cleanup(1)); return api; },
      expire: () => {
        // The middleware's sliding-expiry write is its last Redis call; losing
        // Redis here means the handler runs with no cache at all.
        ops.push(async () => {
          if (state.dropRedisAfterAuth) redis.current = null;
          return 1;
        });
        return api;
      },
      exec: async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push([null, await op()]);
        return out;
      },
    };
    return api;
  };
  return {
    get: vi.fn(async (key: string) => state.cache.get(key) ?? null),
    del: vi.fn(async (key: string) => cleanup(state.cache.delete(key) ? 1 : 0)),
    srem: vi.fn(async () => cleanup(1)),
    expire: vi.fn(async () => 1),
    multi: vi.fn(() => chain()),
  };
}
const redis = vi.hoisted(() => ({ current: null as ReturnType<typeof fakeRedis> | null }));
vi.mock('../../services/redis', () => ({ getRedis: () => redis.current }));

import { Hono } from 'hono';
import { authRoutes, portalAuthMiddleware } from './auth';
import { PORTAL_REDIS_KEYS, PORTAL_SESSION_COOKIE_NAME } from './schemas';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const TOKEN = 'portal-session-token-under-test';
const OTHER_TOKEN = 'portal-session-token-other-device';

function collectSqlValues(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (node === null || typeof node !== 'object') {
    out.push(node);
    return out;
  }
  if (seen.has(node)) return out;
  seen.add(node);
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) for (const chunk of chunks) collectSqlValues(chunk, out, seen);
  const value = (node as { value?: unknown }).value;
  if (value !== undefined && !Array.isArray(chunks)) collectSqlValues(value, out, seen);
  return out;
}

function cacheSession(token: string) {
  state.cache.set(
    PORTAL_REDIS_KEYS.session(token),
    JSON.stringify({ portalUserId: USER_ID, orgId: ORG_ID, authEpoch: 1 }),
  );
}

function protectedApp() {
  const app = new Hono();
  app.use('*', portalAuthMiddleware);
  app.get('/protected', (c) => c.json({ ok: true }));
  return app;
}

function logout(token = TOKEN) {
  return authRoutes.request('/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.clear();
  state.selectedColumns = [];
  state.failCleanup = false;
  state.dropRedisAfterAuth = false;
  redis.current = fakeRedis();
  state.row = {
    id: USER_ID,
    orgId: ORG_ID,
    email: 'cust@acme.example',
    name: 'Cust',
    contactId: null,
    receiveNotifications: true,
    status: 'active',
    authMethod: 'password',
    authEpoch: 1,
    sessionRevoked: false,
  };
  cacheSession(TOKEN);
  cacheSession(OTHER_TOKEN);
});

describe('portal middleware refuses a revoked session token', () => {
  it('401s a token recorded as revoked even while the cache still holds it, and drops the cache entry', async () => {
    state.row = { ...state.row, sessionRevoked: true };
    const res = await protectedApp().request('/protected', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(401);
    expect(state.cache.has(PORTAL_REDIS_KEYS.session(TOKEN))).toBe(false);
  });

  it('checks revocation by token digest inside the one portal user lookup', async () => {
    const res = await protectedApp().request('/protected', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(state.selectedColumns).toHaveLength(1);
    const values = collectSqlValues(state.selectedColumns[0]!.sessionRevoked);
    expect(values).toContain(createHash('sha256').update(TOKEN, 'utf8').digest('hex'));
    expect(values).not.toContain(TOKEN);
  });
});

describe('POST /auth/logout ends the presented portal session durably', () => {
  it('records the presented token before answering and leaves the other session cached', async () => {
    const res = await logout();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(revokePortalSessionDurably).toHaveBeenCalledWith(TOKEN, USER_ID);
    expect(state.cache.has(PORTAL_REDIS_KEYS.session(TOKEN))).toBe(false);
    expect(state.cache.has(PORTAL_REDIS_KEYS.session(OTHER_TOKEN))).toBe(true);
  });

  it('never reports success when the durable record cannot be written, but still clears the cookie', async () => {
    revokePortalSessionDurably.mockRejectedValueOnce(new Error('synthetic database fault'));
    const res = await authRoutes.request('/auth/logout', {
      method: 'POST',
      headers: { cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}`, Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Logout could not be fully completed. Please try again.' });
    expect(res.headers.get('set-cookie') ?? '').toContain(`${PORTAL_SESSION_COOKIE_NAME}=;`);
  });

  it('succeeds when the cache cleanup fails after the durable record, because the record alone refuses the token', async () => {
    state.failCleanup = true;
    const res = await logout();
    expect(res.status).toBe(200);
    expect(revokePortalSessionDurably).toHaveBeenCalledWith(TOKEN, USER_ID);
  });

  it('succeeds when Redis is gone after authentication, because the record alone refuses the token', async () => {
    state.dropRedisAfterAuth = true;
    const res = await logout();
    expect(res.status).toBe(200);
    expect(redis.current).toBeNull();
    expect(revokePortalSessionDurably).toHaveBeenCalledWith(TOKEN, USER_ID);
  });
});
