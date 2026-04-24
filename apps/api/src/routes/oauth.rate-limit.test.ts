import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const ENV_KEYS = [
  'MCP_OAUTH_ENABLED',
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE_URL',
  'OAUTH_COOKIE_SECRET',
  'OAUTH_JWKS_PRIVATE_JWK',
] as const;

const resetEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

const resetAt = new Date('2026-04-23T00:00:00.000Z');

const importApp = async (rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 1, resetAt }))) => {
  process.env.MCP_OAUTH_ENABLED = 'true';
  vi.doMock('../services/redis', () => ({
    getRedis: vi.fn(() => null),
  }));
  vi.doMock('../services/rate-limit', () => ({
    rateLimiter,
  }));
  vi.doMock('../oauth/provider', () => ({
    getProvider: vi.fn(async () => {
      throw new Error('provider sentinel');
    }),
  }));
  vi.resetModules();

  const { oauthRoutes } = await import('./oauth');
  const app = new Hono();
  app.onError(() => new Response('provider sentinel', { status: 200 }));
  app.route('/oauth', oauthRoutes);
  return app;
};

describe('oauthRoutes rate limits', () => {
  beforeEach(() => {
    resetEnv();
    vi.resetModules();
  });

  afterEach(() => {
    resetEnv();
    vi.doUnmock('../services/redis');
    vi.doUnmock('../services/rate-limit');
    vi.doUnmock('../oauth/provider');
  });

  it('returns 429 on the 11th POST /oauth/reg from the same IP', async () => {
    const rateLimiter = vi.fn(async () => ({
      allowed: rateLimiter.mock.calls.length < 11,
      remaining: 0,
      resetAt,
    }));
    const app = await importApp(rateLimiter);

    for (let i = 0; i < 10; i++) {
      const res = await app.request('/oauth/reg', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      expect(res.status).toBe(200);
    }

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(rateLimiter).toHaveBeenLastCalledWith(null, 'oauth:register:203.0.113.10', 10, 3600);
  });

  it('keys POST /oauth/token by IP even when client_id is present', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 59, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.20',
      },
      body: new URLSearchParams({ client_id: 'foo', grant_type: 'authorization_code' }),
    });

    expect(res.status).toBe(200);
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:token:ip:203.0.113.20', 60, 60);
  });

  it('keys POST /oauth/token by IP when client_id is missing', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 59, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.30, 198.51.100.1',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });

    expect(res.status).toBe(200);
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:token:ip:203.0.113.30', 60, 60);
  });

  it('returns 429 on the 61st POST /oauth/token from the same IP', async () => {
    const rateLimiter = vi.fn(async () => ({
      allowed: rateLimiter.mock.calls.length < 61,
      remaining: 0,
      resetAt,
    }));
    const app = await importApp(rateLimiter);

    for (let i = 0; i < 60; i++) {
      const res = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.35' },
      });
      expect(res.status).toBe(200);
    }

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.35' },
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(rateLimiter).toHaveBeenLastCalledWith(null, 'oauth:token:ip:203.0.113.35', 60, 60);
  });

  it('rate-limits POST /oauth/token/revocation by IP', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: false, remaining: 0, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/token/revocation', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.37',
      },
      body: new URLSearchParams({ token: 'opaque-token', client_id: 'client-1' }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:revocation:ip:203.0.113.37', 60, 60);
  });

  it('keys GET /oauth/auth by IP and rate-limits at 20/minute', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: false, remaining: 0, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/auth', {
      method: 'GET',
      headers: { 'x-forwarded-for': '203.0.113.40' },
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:authorize:203.0.113.40', 20, 60);
  });

  it('does not rate-limit other OAuth paths', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: false, remaining: 0, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/me', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });

    expect(res.status).toBe(200);
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('does not attach the middleware when MCP_OAUTH_ENABLED is false', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: false, remaining: 0, resetAt }));
    vi.doMock('../services/redis', () => ({
      getRedis: vi.fn(() => null),
    }));
    vi.doMock('../services/rate-limit', () => ({
      rateLimiter,
    }));
    vi.resetModules();

    const { oauthRoutes } = await import('./oauth');
    const app = new Hono().route('/oauth', oauthRoutes);
    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.60' },
    });

    expect(res.status).toBe(404);
    expect(rateLimiter).not.toHaveBeenCalled();
  });
});
