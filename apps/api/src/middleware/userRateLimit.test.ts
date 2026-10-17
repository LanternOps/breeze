import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from './auth';
import { userRateLimit } from './userRateLimit';
import { hasDbAccessContext, __runInDbContextForTests } from '../db';

const mockRateLimiter = vi.fn();
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: unknown[]) => mockRateLimiter(...args),
}));
vi.mock('../services/redis', () => ({
  getRedis: () => ({} as any),
}));

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { user: { id: 'user-1' }, scope: 'organization' } as AuthContext);
    await next();
  });
  app.post('/write', userRateLimit('enroll-write', 10, 60), (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => mockRateLimiter.mockReset());

describe('userRateLimit', () => {
  it('allows the request when under the limit', async () => {
    mockRateLimiter.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
    const res = await makeApp().request('/write', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mockRateLimiter).toHaveBeenCalledWith(expect.anything(), 'rl:enroll-write:user-1', 10, 60);
  });

  it('returns 429 when rate-limit exceeded', async () => {
    mockRateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await makeApp().request('/write', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  it('fails closed when auth context is missing (no user id)', async () => {
    const app = new Hono();
    app.post('/write', userRateLimit('enroll-write', 10, 60), (c) => c.json({ ok: true }));
    const res = await app.request('/write', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  // #8334 / #1105 — authMiddleware opens the request's held DB context before
  // route-level middleware runs, so the Redis round-trip must exit it.
  it('runs the limiter outside a held DB context but restores it for the handler', async () => {
    let heldDuringLimiter: boolean | undefined;
    mockRateLimiter.mockImplementation(async () => {
      heldDuringLimiter = hasDbAccessContext();
      return { allowed: true, remaining: 9, resetAt: new Date() };
    });
    let heldInHandler: boolean | undefined;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { user: { id: 'user-1' }, scope: 'organization' } as AuthContext);
      return __runInDbContextForTests(() => next());
    });
    app.post('/write', userRateLimit('enroll-write', 10, 60), (c) => {
      heldInHandler = hasDbAccessContext();
      return c.json({ ok: true });
    });
    const res = await app.request('/write', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(heldDuringLimiter).toBe(false);
    expect(heldInHandler).toBe(true);
  });
});
