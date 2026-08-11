import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Hoisted so individual tests can flip between the in-memory fallback
// (getRedis -> null) and the Redis-backed path that production actually runs.
const mocks = vi.hoisted(() => ({
  getRedis: vi.fn<() => unknown>(() => null),
  rateLimiter: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedis: mocks.getRedis,
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: mocks.rateLimiter,
}));

// Only the IP SOURCE is stubbed. rateLimitIpKey (the IPv6 /64 bucket folding
// the middleware applies to the key) is the real implementation, so these
// tests exercise the actual key derivation.
vi.mock('../services/clientIp', async () => {
  const actual = await vi.importActual<typeof import('../services/clientIp')>('../services/clientIp');
  return {
    ...actual,
    getTrustedClientIp: vi.fn(() => 'global-rate-limit-test'),
  };
});

const TEST_IP = 'global-rate-limit-test';

import {
  __resetInMemoryCountersForTests,
  __resetSkipPrefixesForTests,
  globalRateLimit,
  ISOLATED_BUCKETS,
  registerGlobalRateLimitSkipPrefix,
} from './globalRateLimit';

beforeEach(() => {
  __resetSkipPrefixesForTests();
  __resetInMemoryCountersForTests();
  // Default to the in-memory fallback; the Redis-path tests opt in.
  mocks.getRedis.mockReturnValue(null);
  mocks.rateLimiter.mockReset();
});

describe('globalRateLimit', () => {
  it('skips registered extension agent prefixes', async () => {
    registerGlobalRateLimitSkipPrefix('/api/v1/demo/agent/');
    const app = new Hono();
    app.use('*', globalRateLimit({ limit: 1, windowSeconds: 60 }));
    app.post('/api/v1/demo/agent/batch', (c) => c.json({ ok: true }));

    await app.request('/api/v1/demo/agent/batch', { method: 'POST' });
    const res = await app.request('/api/v1/demo/agent/batch', { method: 'POST' });

    expect(res.status).toBe(200);
  });

  it('resets registered prefixes while preserving built-in prefixes', async () => {
    registerGlobalRateLimitSkipPrefix('/api/v1/demo/agent/');
    __resetSkipPrefixesForTests();

    const app = new Hono();
    app.use('*', globalRateLimit({ limit: 1, windowSeconds: 60 }));
    app.post('/api/v1/demo/agent/batch', (c) => c.json({ ok: true }));
    app.post('/api/v1/agents/batch', (c) => c.json({ ok: true }));

    await app.request('/api/v1/demo/agent/batch', { method: 'POST' });
    const limited = await app.request('/api/v1/demo/agent/batch', { method: 'POST' });
    const builtIn = await app.request('/api/v1/agents/batch', { method: 'POST' });

    expect(limited.status).toBe(429);
    expect(builtIn.status).toBe(200);
  });
});

// Issue #3041: the remote-desktop viewer polls /viewer/session while waiting
// for the agent's WebRTC answer. Those polls used to share the per-IP bucket
// with everything else, so a session that died mid-poll could 429 the
// operator's own dashboard and auth calls and bounce them to the login screen.
describe('globalRateLimit — isolated desktop-ws bucket', () => {
  const VIEWER_PATH = '/api/v1/desktop-ws/00000000-0000-0000-0000-000000000000/viewer/session';

  function buildApp(options?: Parameters<typeof globalRateLimit>[0]) {
    const app = new Hono();
    app.use('*', globalRateLimit(options));
    app.get(VIEWER_PATH, (c) => c.json({ ok: true }));
    app.get('/api/v1/devices', (c) => c.json({ ok: true }));
    app.post('/api/v1/auth/refresh', (c) => c.json({ ok: true }));
    return app;
  }

  it('ships with /api/v1/desktop-ws/ isolated by default', () => {
    expect(ISOLATED_BUCKETS.some((b) => b.prefix === '/api/v1/desktop-ws/')).toBe(true);
  });

  it('does not let viewer polls drain the shared bucket', async () => {
    // Shared budget of 2, but 20 viewer polls — far past what the shared
    // bucket would tolerate if they were metered together.
    const app = buildApp({ limit: 2, windowSeconds: 60 });

    for (let i = 0; i < 20; i++) {
      const poll = await app.request(VIEWER_PATH);
      expect(poll.status).toBe(200);
    }

    // The dashboard and the token refresh must still have their full budget.
    expect((await app.request('/api/v1/devices')).status).toBe(200);
    expect((await app.request('/api/v1/auth/refresh', { method: 'POST' })).status).toBe(200);
  });

  it('still caps viewer traffic — isolation is not exemption', async () => {
    const app = buildApp({
      limit: 100,
      windowSeconds: 60,
      isolatedBuckets: [{ prefix: '/api/v1/desktop-ws/', name: 'desktopws-test', limit: 2 }],
    });

    expect((await app.request(VIEWER_PATH)).status).toBe(200);
    expect((await app.request(VIEWER_PATH)).status).toBe(200);

    const throttled = await app.request(VIEWER_PATH);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('60');
    expect(throttled.headers.get('X-RateLimit-Limit')).toBe('2');
  });

  // Production always has Redis, so the in-memory assertions above exercise the
  // fallback rather than the real path. Pin the key/limit actually handed to the
  // Redis limiter too.
  it('hands the isolated key and limit to the Redis limiter', async () => {
    const fakeRedis = { marker: 'redis' };
    mocks.getRedis.mockReturnValue(fakeRedis);
    mocks.rateLimiter.mockResolvedValue({
      allowed: true,
      remaining: 599,
      resetAt: new Date(Date.now() + 60_000),
    });
    const app = buildApp({ limit: 300, windowSeconds: 60 });

    await app.request(VIEWER_PATH);
    expect(mocks.rateLimiter).toHaveBeenCalledWith(
      fakeRedis,
      `global:desktopws:${TEST_IP}`,
      600,
      60,
    );

    mocks.rateLimiter.mockClear();
    await app.request('/api/v1/devices');
    expect(mocks.rateLimiter).toHaveBeenCalledWith(
      fakeRedis,
      `global:${TEST_IP}`,
      300,
      60,
    );
  });

  it('exhausting the shared bucket does not throttle viewer traffic', async () => {
    const app = buildApp({ limit: 1, windowSeconds: 60 });

    expect((await app.request('/api/v1/devices')).status).toBe(200);
    expect((await app.request('/api/v1/devices')).status).toBe(429);

    // An in-flight remote session must survive an unrelated dashboard burst.
    expect((await app.request(VIEWER_PATH)).status).toBe(200);
  });
});
