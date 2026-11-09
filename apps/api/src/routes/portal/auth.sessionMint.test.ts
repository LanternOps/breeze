/**
 * The browser-session mint under the Redis backend (portal registration W4,
 * plan Task 6). Login and accept-invite both mint through
 * `mintPortalBrowserSession`; this pins that the Redis payload, the key
 * writes and the cookies are byte-identical to what the routes wrote before
 * the shared mint existed, and that an entra mint adds only `entraTenantId`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PORTAL_STATE_BACKEND = 'redis';
});

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

const state = vi.hoisted(() => ({
  ops: [] as unknown[][],
  loginRow: null as Record<string, unknown> | null,
  activatedEpoch: 5,
  dropRedisOnPurge: false,
}));

function fakeRedis() {
  return {
    multi: vi.fn(() => {
      const queued: unknown[][] = [];
      const api = {
        setex: (...a: unknown[]) => { queued.push(['setex', ...a]); return api; },
        sadd: (...a: unknown[]) => { queued.push(['sadd', ...a]); return api; },
        expire: (...a: unknown[]) => { queued.push(['expire', ...a]); return api; },
        exec: async () => { state.ops.push(...queued); return queued.map(() => [null, 'OK']); },
      };
      return api;
    }),
  };
}
const redis = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../services/redis', () => ({ getRedis: () => redis.current }));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(state.loginRow ? [state.loginRow] : []) }) }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ authEpoch: state.activatedEpoch }]),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
        }),
      }),
    }),
  },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
vi.mock('../../db/schema', () => ({
  discoveredAssetTypeEnum: { enumValues: [] },
  organizations: { id: 'id', partnerId: 'partnerId', name: 'name' },
  partners: { id: 'id', name: 'name' },
  portalUsers: {
    id: 'id', orgId: 'orgId', email: 'email', name: 'name', contactId: 'contactId', passwordHash: 'passwordHash',
    authMethod: 'authMethod', authEpoch: 'authEpoch', receiveNotifications: 'receiveNotifications', status: 'status',
    browserAccess: 'browserAccess', lastLoginAt: 'lastLoginAt', updatedAt: 'updatedAt',
  },
  portalBranding: { orgId: 'orgId', enablePasswordReset: 'enablePasswordReset' },
}));
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({ orgId: ORG_ID, partnerId: 'partner-1' })),
  isUsableOrgStatus: (s: string) => s === 'active' || s === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));
vi.mock('../../services/password', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/password')>()),
  verifyPassword: vi.fn(async () => true),
  hashPassword: vi.fn(async () => 'hashed'),
}));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: vi.fn(async () => undefined),
}));
vi.mock('../../services/clientAiSessionStore', () => ({ purgeClientAiSessionsForUsers: vi.fn(async () => undefined) }));
vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  clearRateLimitKeys: vi.fn(async () => undefined),
  purgePortalSessionsForUsers: vi.fn(async () => {
    if (state.dropRedisOnPurge) redis.current = null;
    return 0;
  }),
}));
// The invite token itself is capabilityTokens.test.ts's subject: here it is a valid, consumed v2 invite.
vi.mock('./capabilityTokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./capabilityTokens')>()),
  consumePortalCapabilityToken: vi.fn(async () => ({
    format: 'v2',
    payload: { v: 2, purpose: 'invite', portalUserId: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', authEpoch: 4 },
  })),
  validatePortalCapability: vi.fn(async () => ({
    ok: true,
    user: {
      id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: 'Cust', passwordHash: null, authMethod: 'password',
      receiveNotifications: true, status: 'invited', authEpoch: 4, browserAccess: 'granted', hasExternalIdentity: false, orgName: 'Acme',
    },
  })),
}));
const resolvePolicy = vi.hoisted(() => vi.fn());
vi.mock('../../services/portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalAccessPolicy')>()),
  resolvePortalAccessPolicy: resolvePolicy,
}));

import { Hono } from 'hono';
import { authRoutes } from './auth';
import { PortalSessionStoreUnavailableError, mintPortalBrowserSession } from './browserSession';
import { buildPortalCsrfCookie, buildPortalSessionCookie, portalSessions } from './helpers';
import { PORTAL_CSRF_COOKIE_NAME, SESSION_TTL_SECONDS } from './schemas';
import { pickEffectivePortalAccessPolicy } from '../../services/portalAccessPolicy';

const app = (() => {
  const a = new Hono();
  a.route('/', authRoutes);
  a.post('/test-mint', async (c) => {
    try {
      return c.json(await mintPortalBrowserSession(c, await c.req.json()));
    } catch (error) {
      if (error instanceof PortalSessionStoreUnavailableError) return c.json({ unavailable: true }, 503);
      throw error;
    }
  });
  return a;
})();
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** The exact bytes the pre-W4 routes wrote: these keys, in this order. */
function expectPre4PasswordPayload(payload: string, authEpoch: number, before: number, after: number) {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(['portalUserId', 'orgId', 'authEpoch', 'method', 'createdAt']);
  expect(payload).toBe(JSON.stringify({ portalUserId: USER_ID, orgId: ORG_ID, authEpoch, method: 'password', createdAt: parsed.createdAt }));
  const createdAt = Date.parse(parsed.createdAt as string);
  expect(new Date(createdAt).toISOString()).toBe(parsed.createdAt);
  expect(createdAt).toBeGreaterThanOrEqual(before);
  expect(createdAt).toBeLessThanOrEqual(after);
}

/** setex the session (24 h), index it, extend the index (48 h): exactly these three writes. */
function expectSessionWrites(token: string): string {
  expect(state.ops).toEqual([
    ['setex', `portal:session:${token}`, SESSION_TTL_SECONDS, expect.any(String)],
    ['sadd', `portal:user-sessions:${USER_ID}`, token],
    ['expire', `portal:user-sessions:${USER_ID}`, SESSION_TTL_SECONDS * 2],
  ]);
  return state.ops[0]![3] as string;
}

/** The session cookie carries the token; the CSRF cookie a fresh 32-byte value; nothing else is set. */
function expectSessionCookies(res: Response, token: string) {
  const cookies = res.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  expect(cookies[0]).toBe(buildPortalSessionCookie(token, false));
  const csrf = new RegExp(`^${PORTAL_CSRF_COOKIE_NAME}=([0-9a-f]{64});`).exec(cookies[1]!)?.[1];
  expect(csrf).toBeDefined();
  expect(cookies[1]).toBe(buildPortalCsrfCookie(csrf!, false));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.ops.length = 0;
  state.activatedEpoch = 5;
  state.dropRedisOnPurge = false;
  redis.current = fakeRedis();
  portalSessions.clear();
  state.loginRow = {
    id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: 'Cust', passwordHash: 'hash', authMethod: 'password',
    receiveNotifications: true, status: 'active', authEpoch: 3, orgName: 'Acme',
  };
  resolvePolicy.mockImplementation(async (orgId: string) => ({
    orgId, partnerId: 'partner-1', entraTenant: null,
    ...pickEffectivePortalAccessPolicy(null, null, { entra: false, google: false, selfRegistration: false }, { entraTenantProven: false }),
  }));
});

describe('session mint under the Redis backend', () => {
  it('login and accept-invite still mint the same Redis payload and cookies (method password, createdAt)', async () => {
    let before = Date.now();
    const login = await post('/auth/login', { email: 'cust@acme.example', password: 'Right1!pass', orgId: ORG_ID });
    let after = Date.now();
    expect(login.status).toBe(200);
    const loginBody = await login.json() as { accessToken: string; expiresAt: string; tokens: { accessToken: string; expiresInSeconds: number } };
    const loginToken = loginBody.accessToken;
    expect(loginToken).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(loginBody.tokens).toEqual({ accessToken: loginToken, expiresInSeconds: SESSION_TTL_SECONDS });
    const loginPayload = expectSessionWrites(loginToken);
    expectPre4PasswordPayload(loginPayload, 3, before, after);
    expect(Date.parse(loginBody.expiresAt)).toBe(Date.parse(JSON.parse(loginPayload).createdAt) + SESSION_TTL_SECONDS * 1000);
    expectSessionCookies(login, loginToken);

    state.ops.length = 0;
    before = Date.now();
    const accepted = await post('/auth/accept-invite', { token: 'invite-token', password: 'Str0ng!Passw0rd#' });
    after = Date.now();
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as { accessToken: string; expiresAt: string };
    const acceptedToken = acceptedBody.accessToken;
    expect(acceptedToken).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(acceptedToken).not.toBe(loginToken);
    // The session carries the epoch the activation advanced to, not the invite's.
    const acceptedPayload = expectSessionWrites(acceptedToken);
    expectPre4PasswordPayload(acceptedPayload, 5, before, after);
    expect(Date.parse(acceptedBody.expiresAt)).toBe(Date.parse(JSON.parse(acceptedPayload).createdAt) + SESSION_TTL_SECONDS * 1000);
    expectSessionCookies(accepted, acceptedToken);

    // Redis is authoritative: the in-memory twin is never written in this mode.
    expect(portalSessions.size).toBe(0);
  });

  it('an entra mint writes the same payload plus entraTenantId, and nothing in memory', async () => {
    const before = Date.now();
    const res = await post('/test-mint', { portalUserId: USER_ID, orgId: ORG_ID, authEpoch: 7, method: 'entra', entraTenantId: TENANT });
    const after = Date.now();
    expect(res.status).toBe(200);
    const { token } = await res.json() as { token: string };
    const payload = expectSessionWrites(token);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(payload).toBe(JSON.stringify({
      portalUserId: USER_ID, orgId: ORG_ID, authEpoch: 7, method: 'entra', createdAt: parsed.createdAt, entraTenantId: TENANT,
    }));
    expect(Date.parse(parsed.createdAt as string)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(parsed.createdAt as string)).toBeLessThanOrEqual(after);
    expectSessionCookies(res, token);
    expect(portalSessions.size).toBe(0);
  });

  it('login answers 503 and sets no cookie when the session store is unavailable', async () => {
    redis.current = null;
    const res = await post('/auth/login', { email: 'cust@acme.example', password: 'Right1!pass', orgId: ORG_ID });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(portalSessions.size).toBe(0);
  });

  it('a null multi().exec() result (aborted transaction) is a store failure: 503, no cookie, nothing in memory', async () => {
    const aborted = fakeRedis();
    aborted.multi = vi.fn(() => {
      const api = {
        setex: (..._a: unknown[]) => api,
        sadd: (..._a: unknown[]) => api,
        expire: (..._a: unknown[]) => api,
        // ioredis types exec() as never-null; an aborted MULTI returns null at runtime.
        exec: async () => null as unknown as (string | null)[][],
      };
      return api;
    }) as unknown as typeof aborted.multi;
    redis.current = aborted;
    const res = await post('/test-mint', { portalUserId: USER_ID, orgId: ORG_ID, authEpoch: 7, method: 'password' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ unavailable: true });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(portalSessions.size).toBe(0);
  });

  it('accept-invite never answers 200 with a session it could not store', async () => {
    // Redis passes the route's up-front check, then disappears before the mint.
    state.dropRedisOnPurge = true;
    const res = await post('/auth/accept-invite', { token: 'invite-token', password: 'Str0ng!Passw0rd#' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(state.ops).toEqual([]);
    expect(portalSessions.size).toBe(0);
  });
});
