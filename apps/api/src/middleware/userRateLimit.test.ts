import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from './auth';
import { userRateLimit } from './userRateLimit';

const mockRateLimiter = vi.fn();
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: unknown[]) => mockRateLimiter(...args),
}));
vi.mock('../services', () => ({
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
});
