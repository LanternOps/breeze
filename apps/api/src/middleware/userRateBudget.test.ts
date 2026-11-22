import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * #10962 — the front door (globalRateLimit) composed with the REAL
 * authMiddleware, because the two halves only mean anything together: the front
 * door decides which IP bucket a request spends and whether it owes a per-user
 * budget, authMiddleware is where that budget is charged.
 *
 * Tokens are stubbed by name (`token-<user>`), so a test reads as "who is
 * calling". Everything authMiddleware reads after the budget check is stubbed
 * only far enough to let a system-scope session through.
 */
const mocks = vi.hoisted(() => ({
  getRedis: vi.fn<() => unknown>(() => null),
  rateLimiter: vi.fn(),
  verifyToken: vi.fn(),
  dbSelect: vi.fn(),
  lastSub: { value: '' },
}));

vi.mock('../services/redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('../services/jwt', () => ({ verifyToken: mocks.verifyToken }));

vi.mock('../services/clientIp', async () => {
  const actual = await vi.importActual<typeof import('../services/clientIp')>('../services/clientIp');
  return { ...actual, getTrustedClientIp: vi.fn(() => 'office-nat') };
});

vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(),
  hasPermission: vi.fn(),
  canAccessOrg: vi.fn(),
  canAccessSite: vi.fn(),
}));
vi.mock('../services/tokenRevocation', () => ({
  isUserTokenRevoked: vi.fn().mockResolvedValue(false),
  isTokenIssuedBeforePasswordChange: vi.fn(() => false),
}));
vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/auditEvents', () => ({ writeAuditEvent: vi.fn() }));
vi.mock('../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(async () => ({ required: false })),
}));
vi.mock('./ipAllowlistGuard', () => ({
  ipAllowlistGuard: vi.fn(async (_c: unknown, next: () => Promise<void>) => { await next(); }),
}));
vi.mock('./mobileDeviceBlocked', () => ({
  getBoundMobileDeviceBlock: vi.fn(async () => null),
  mobileDeviceBlockedResponse: vi.fn(),
}));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  db: { select: mocks.dbSelect },
  withDbAccessContext: vi.fn(async (_context: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { readFileSync } from 'node:fs';
import { authMiddleware } from './auth';
import { httpExceptionResponse } from './httpExceptionResponse';
import { isUserTokenRevoked } from '../services/tokenRevocation';
import {
  __resetInMemoryCountersForTests,
  globalRateLimit,
  ISOLATED_BUCKETS,
} from './globalRateLimit';

const IP = 'office-nat';
const ENV_VAR = 'USER_RATE_LIMIT_PER_MINUTE';

function bearer(user: string) {
  return { headers: { Authorization: `Bearer token-${user}` } };
}

/** The HTTPException handling index.ts's onError uses (pinned below). */
function appErrorHandler(err: Error, c: Context) {
  if (err instanceof HTTPException) return httpExceptionResponse(err, c);
  return c.json({ error: 'boom', detail: String(err) }, 500);
}

/**
 * `limit` is the shared anonymous per-IP bucket. The session ceiling stays out
 * of the way unless a test is about it.
 */
function buildApp(options: Parameters<typeof globalRateLimit>[0] = {}) {
  const app = new Hono();
  app.onError(appErrorHandler);
  app.use('*', globalRateLimit({ limit: 2, windowSeconds: 60, sessionIpLimit: 1000, ...options }));
  app.get('/api/v1/devices', authMiddleware, (c) => c.json({ ok: true }));
  app.get('/api/v1/desktop-ws/s1/viewer/session', authMiddleware, (c) => c.json({ ok: true }));
  app.get('/api/v1/agent-ws/a1/ws', (c) => c.json({ ok: true }));
  // An unauthenticated route: a valid token is sent but nothing authenticates it.
  app.get('/api/v1/public/thing', (c) => c.json({ ok: true }));
  // The shape mfa.ts and platformAdmin.ts use: authMiddleware's return value is
  // dropped, so a denial that is only RETURNED would be lost.
  app.post('/api/v1/auth/mfa/confirm', async (c) => {
    await authMiddleware(c, async () => {});
    return c.json({ user: c.get('auth').user.id });
  });
  return app;
}

function redisAllows() {
  const fakeRedis = { marker: 'redis' };
  mocks.getRedis.mockReturnValue(fakeRedis);
  mocks.rateLimiter.mockResolvedValue({
    allowed: true,
    remaining: 42,
    resetAt: new Date(Date.now() + 60_000),
  });
  return fakeRedis;
}

function chargedKeys(): string[] {
  return mocks.rateLimiter.mock.calls.map((call) => call[1] as string);
}

beforeEach(() => {
  __resetInMemoryCountersForTests();
  vi.stubEnv(ENV_VAR, '5');
  mocks.getRedis.mockReset();
  mocks.getRedis.mockReturnValue(null);
  mocks.rateLimiter.mockReset();
  mocks.dbSelect.mockReset();
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{
          id: mocks.lastSub.value,
          email: `${mocks.lastSub.value}@example.test`,
          name: mocks.lastSub.value,
          status: 'active',
          passwordChangedAt: null,
          mfaEnabled: true,
          partnerId: null,
          isPlatformAdmin: true,
          authEpoch: 1,
          mfaEpoch: 1,
        }],
      }),
    }),
  }));
  mocks.verifyToken.mockReset();
  mocks.verifyToken.mockImplementation(async (token: string) => {
    const accessMatch = /^token-(.+)$/.exec(token);
    if (accessMatch) {
      mocks.lastSub.value = accessMatch[1]!;
      return {
        sub: accessMatch[1],
        email: `${accessMatch[1]}@example.test`,
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'access',
        mfa: true,
        aep: 1,
        mep: 1,
        sid: 'sid-1',
        iat: 1,
      };
    }
    if (token === 'refresh-alice') {
      return { sub: 'alice', type: 'refresh', scope: 'system' };
    }
    return null;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('per-user budget behind one IP (#10962)', () => {
  it('several users behind one IP do not 429 each other', async () => {
    const app = buildApp();
    // Shared bucket is 2; 5 users at 5 requests each would be 25 in one bucket.
    for (const user of ['alice', 'bob', 'carol', 'dave', 'erin']) {
      for (let i = 0; i < 5; i += 1) {
        expect((await app.request('/api/v1/devices', bearer(user))).status).toBe(200);
      }
    }
  });

  it('one user over budget is 429 while another on the same IP is not', async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(200);
    }
    const throttled = await app.request('/api/v1/devices', bearer('alice'));
    expect(throttled.status).toBe(429);
    expect((await app.request('/api/v1/devices', bearer('bob'))).status).toBe(200);
  });

  it('answers 429 in the shape the web expects', async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) await app.request('/api/v1/devices', bearer('alice'));
    const throttled = await app.request('/api/v1/devices', bearer('alice'));

    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('60');
    expect(throttled.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(throttled.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(((await throttled.json()) as { error: string }).error).toBe('Too many requests');
  });

  it('refuses an over-budget user before authMiddleware reads Postgres', async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) await app.request('/api/v1/devices', bearer('alice'));
    mocks.dbSelect.mockClear();

    expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(429);
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });

  it('a caller that drops authMiddleware\'s return value still gets the 429', async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/api/v1/auth/mfa/confirm', { method: 'POST', ...bearer('alice') })).status).toBe(200);
    }
    const throttled = await app.request('/api/v1/auth/mfa/confirm', { method: 'POST', ...bearer('alice') });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('60');
  });
});

// extensions/gateway.ts dispatches through `wrapper.app.fetch(c.req.raw, ...)`,
// which builds a NEW Hono context: nothing set on the outer context reaches the
// inner authMiddleware, and headers set on the inner one do not reach the outer
// onError. The budget has to survive that hop in both directions.
describe('authMiddleware behind an inner-app dispatch (#10962)', () => {
  function buildGatewayShapedApp() {
    const inner = new Hono();
    inner.use('*', (c, next) => authMiddleware(c, next) as Promise<void>);
    inner.get('/api/v1/ext/widgets/thing', (c) => c.json({ ok: true }));
    inner.onError((error) => { throw error; });

    const app = new Hono();
    app.onError(appErrorHandler);
    app.use('*', globalRateLimit({ limit: 2, windowSeconds: 60, sessionIpLimit: 1000 }));
    app.all('/api/v1/ext/*', (c) => inner.fetch(c.req.raw));
    return app;
  }

  it('still charges the per-user budget', async () => {
    const app = buildGatewayShapedApp();
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/api/v1/ext/widgets/thing', bearer('alice'))).status).toBe(200);
    }
    expect((await app.request('/api/v1/ext/widgets/thing', bearer('alice'))).status).toBe(429);
    expect((await app.request('/api/v1/ext/widgets/thing', bearer('bob'))).status).toBe(200);
  });

  it('keeps the 429 headers across the hop', async () => {
    const app = buildGatewayShapedApp();
    for (let i = 0; i < 5; i += 1) await app.request('/api/v1/ext/widgets/thing', bearer('alice'));
    const throttled = await app.request('/api/v1/ext/widgets/thing', bearer('alice'));

    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('60');
    expect(throttled.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(((await throttled.json()) as { error: string }).error).toBe('Too many requests');
  });
});

describe('the per-IP bucket stays the anonymous and abuse ceiling (#10962)', () => {
  it('anonymous traffic still hits the shared per-IP cap', async () => {
    const app = buildApp();
    expect((await app.request('/api/v1/public/thing')).status).toBe(200);
    expect((await app.request('/api/v1/public/thing')).status).toBe(200);
    const throttled = await app.request('/api/v1/public/thing');
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('60');
    expect(throttled.headers.get('X-RateLimit-Limit')).toBe('2');
  });

  it('exhausted anonymous traffic does not block a session on the same IP, and vice versa', async () => {
    const app = buildApp();
    await app.request('/api/v1/public/thing');
    await app.request('/api/v1/public/thing');
    expect((await app.request('/api/v1/public/thing')).status).toBe(429);
    expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(200);
  });

  it('session traffic does not spend the anonymous bucket', async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) await app.request('/api/v1/devices', bearer('alice'));
    expect((await app.request('/api/v1/public/thing')).status).toBe(200);
    expect((await app.request('/api/v1/public/thing')).status).toBe(200);
    expect((await app.request('/api/v1/public/thing')).status).toBe(429);
  });

  // The bypass this test guards: "a bearer header" must not be enough to leave
  // the anonymous bucket, or `Authorization: Bearer x` is a free pass.
  it.each([
    ['a forged token', 'forged'],
    ['a refresh token', 'refresh-alice'],
    ['a non-JWT bearer', 'brz_not_a_jwt'],
  ])('%s stays in the anonymous bucket', async (_label, token) => {
    const app = buildApp();
    const headers = { Authorization: `Bearer ${token}` };
    expect((await app.request('/api/v1/public/thing', { headers })).status).toBe(200);
    expect((await app.request('/api/v1/public/thing', { headers })).status).toBe(200);
    expect((await app.request('/api/v1/public/thing', { headers })).status).toBe(429);
  });

  it('a raised per-IP ceiling still bounds valid sessions, across users', async () => {
    const app = buildApp({ sessionIpLimit: 3 });
    expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(200);
    expect((await app.request('/api/v1/devices', bearer('bob'))).status).toBe(200);
    expect((await app.request('/api/v1/devices', bearer('carol'))).status).toBe(200);
    const throttled = await app.request('/api/v1/devices', bearer('dave'));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('X-RateLimit-Limit')).toBe('3');
  });

  it('defaults the session ceiling to ten saturated users on one IP', async () => {
    const fakeRedis = redisAllows();
    vi.stubEnv(ENV_VAR, '');
    const app = new Hono();
    app.use('*', globalRateLimit());
    app.get('/api/v1/devices', authMiddleware, (c) => c.json({ ok: true }));

    await app.request('/api/v1/devices', bearer('alice'));
    expect(mocks.rateLimiter).toHaveBeenCalledWith(fakeRedis, `global:session:${IP}`, 6000, 60);
  });

  it('a valid token on a route with no authMiddleware is bounded by the ceiling, not unmetered', async () => {
    const fakeRedis = redisAllows();
    const app = buildApp();
    await app.request('/api/v1/public/thing', bearer('alice'));
    expect(mocks.rateLimiter).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimiter).toHaveBeenCalledWith(fakeRedis, `global:session:${IP}`, 1000, 60);
  });
});

describe('API-key requests (#10962)', () => {
  // Defined choice: an API key is not a session. It stays in the shared per-IP
  // bucket and keeps its own per-key hourly limit in apiKeyAuth, with no
  // per-user budget.
  it.each([
    ['X-API-Key', { 'X-API-Key': 'brz_key' }],
    ['a bearer API key', { Authorization: 'Bearer brz_key' }],
  ])('%s is metered in the shared per-IP bucket, with no per-user budget', async (_label, headers) => {
    const fakeRedis = redisAllows();
    const app = buildApp();
    await app.request('/api/v1/public/thing', { headers });
    expect(chargedKeys()).toEqual([`global:${IP}`]);
    expect(mocks.rateLimiter).toHaveBeenCalledWith(fakeRedis, `global:${IP}`, 2, 60);
  });
});

describe('isolated buckets (#10962)', () => {
  it('gives /api/v1/agent-ws/ its own bucket', () => {
    expect(ISOLATED_BUCKETS).toContainEqual({ prefix: '/api/v1/agent-ws/', name: 'agentws', limit: 3000 });
  });

  it('a fleet behind one NAT cannot spend the shared or session budget', async () => {
    const app = buildApp();
    for (let i = 0; i < 20; i += 1) {
      expect((await app.request('/api/v1/agent-ws/a1/ws')).status).toBe(200);
    }
    expect((await app.request('/api/v1/public/thing')).status).toBe(200);
    expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(200);
  });

  it('agent-ws is capped — isolation is not exemption', async () => {
    const app = buildApp({
      isolatedBuckets: [{ prefix: '/api/v1/agent-ws/', name: 'agentws-test', limit: 2 }],
    });
    expect((await app.request('/api/v1/agent-ws/a1/ws')).status).toBe(200);
    expect((await app.request('/api/v1/agent-ws/a1/ws')).status).toBe(200);
    expect((await app.request('/api/v1/agent-ws/a1/ws')).status).toBe(429);
  });

  it('a session on an isolated path spends that bucket only, not the per-user budget', async () => {
    redisAllows();
    const app = buildApp();
    const res = await app.request('/api/v1/desktop-ws/s1/viewer/session', bearer('alice'));
    expect(res.status).toBe(200);
    expect(chargedKeys()).toEqual([`global:desktopws:${IP}`]);
  });
});

describe('budget wiring (#10962)', () => {
  it('charges rl:session:<userId> on the Redis path, refunding rejected attempts', async () => {
    const fakeRedis = redisAllows();
    const app = buildApp();
    await app.request('/api/v1/devices', bearer('alice'));

    expect(chargedKeys()).toEqual([`global:session:${IP}`, 'rl:session:alice']);
    expect(mocks.rateLimiter).toHaveBeenCalledWith(
      fakeRedis,
      'rl:session:alice',
      5,
      60,
      1,
      { refundOnReject: true },
    );
  });

  it('charges one budget unit when authMiddleware runs twice on a request', async () => {
    redisAllows();
    const app = new Hono();
    app.use('*', globalRateLimit({ limit: 2, windowSeconds: 60 }));
    app.get('/api/v1/devices', authMiddleware, authMiddleware, (c) => c.json({ ok: true }));
    await app.request('/api/v1/devices', bearer('alice'));
    expect(chargedKeys().filter((k) => k.startsWith('rl:session:'))).toHaveLength(1);
  });

  it.each([
    ['unset', undefined],
    ['empty (compose renders an unset var as "")', ''],
    ['not a number', 'lots'],
    ['zero', '0'],
    ['negative', '-5'],
  ])('falls back to 600/min when the env var is %s', async (_label, value) => {
    const fakeRedis = redisAllows();
    if (value === undefined) delete process.env[ENV_VAR];
    else vi.stubEnv(ENV_VAR, value);
    const app = buildApp();
    await app.request('/api/v1/devices', bearer('alice'));
    expect(mocks.rateLimiter).toHaveBeenCalledWith(
      fakeRedis,
      'rl:session:alice',
      600,
      60,
      1,
      { refundOnReject: true },
    );
  });

  it('honours the env override', async () => {
    const fakeRedis = redisAllows();
    vi.stubEnv(ENV_VAR, '1200');
    const app = buildApp();
    await app.request('/api/v1/devices', bearer('alice'));
    expect(mocks.rateLimiter).toHaveBeenCalledWith(
      fakeRedis,
      'rl:session:alice',
      1200,
      60,
      1,
      { refundOnReject: true },
    );
  });

  it('a revoked token is refused without spending its owner\'s budget', async () => {
    redisAllows();
    vi.mocked(isUserTokenRevoked).mockResolvedValueOnce(true);
    const res = await buildApp().request('/api/v1/devices', bearer('alice'));
    expect(res.status).toBe(401);
    expect(chargedKeys()).toEqual([`global:session:${IP}`]);
  });

  it.each([
    ['the per-user budget', 'user_rate_budget', '1'],
    ['the session ceiling', 'global_rate_limit', '100'],
  ])('labels a refusal from %s in the request log', async (_label, reason, budget) => {
    let logged: unknown;
    const app = new Hono();
    app.onError(appErrorHandler);
    app.use('*', async (c, next) => {
      await next();
      logged = c.get('rejectReason');
    });
    app.use('*', globalRateLimit({ limit: 2, windowSeconds: 60, sessionIpLimit: 3 }));
    app.get('/api/v1/devices', authMiddleware, (c) => c.json({ ok: true }));
    vi.stubEnv(ENV_VAR, budget);

    let last = 0;
    for (let i = 0; i < 5 && last !== 429; i += 1) {
      last = (await app.request('/api/v1/devices', bearer('alice'))).status;
    }
    expect(last).toBe(429);
    expect(logged).toBe(reason);
  });

  it('index.ts answers an HTTPException through the handler these tests use', () => {
    const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const onError = indexSource.slice(indexSource.indexOf('app.onError((err, c) => {'));
    expect(onError.slice(0, 200)).toContain('return httpExceptionResponse(err, c);');
  });

  it('never meters a route mounted without the front door', async () => {
    redisAllows();
    const app = new Hono();
    app.get('/api/v1/devices', authMiddleware, (c) => c.json({ ok: true }));
    expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(200);
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });

  it('E2E_MODE meters nothing: the front door skips, so the budget is never owed', async () => {
    redisAllows();
    vi.stubEnv('E2E_MODE', '1');
    const app = buildApp();
    expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(200);
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });
});

// Pins the existing middleware's choice for the new buckets: no client at all
// falls back to the per-process in-memory counters (metered, not open). A Redis
// client whose commands fail makes rateLimiter return a deny (its fail-closed is
// pinned in services/rate-limit.test.ts); these tests pin that a deny from it
// surfaces as a normal 429 with Retry-After at each step.
describe('Redis failure behaviour (#10962)', () => {
  it('Redis client absent: both new buckets fall back to in-memory counters, still metered', async () => {
    mocks.getRedis.mockReturnValue(null);
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(200);
    }
    expect((await app.request('/api/v1/devices', bearer('alice'))).status).toBe(429);
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });

  it('a fail-closed deny at the front door answers 429', async () => {
    mocks.getRedis.mockReturnValue({ marker: 'redis' });
    mocks.rateLimiter.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });
    const res = await buildApp().request('/api/v1/devices', bearer('alice'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(chargedKeys()).toEqual([`global:session:${IP}`]);
  });

  it('a fail-closed deny at the per-user step answers 429', async () => {
    mocks.getRedis.mockReturnValue({ marker: 'redis' });
    mocks.rateLimiter.mockImplementation(async (_redis: unknown, key: string) => ({
      allowed: !key.startsWith('rl:session:'),
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    }));
    const res = await buildApp().request('/api/v1/devices', bearer('alice'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });
});
