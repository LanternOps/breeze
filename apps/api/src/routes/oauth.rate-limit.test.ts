import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';

const ENV_KEYS = [
  'MCP_OAUTH_ENABLED',
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE_URL',
  'OAUTH_COOKIE_SECRET',
  'OAUTH_JWKS_PRIVATE_JWK',
  'OAUTH_DCR_ENABLED',
  'NODE_ENV',
  'TRUST_PROXY_HEADERS',
] as const;

const resetEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

const resetAt = new Date('2026-04-23T00:00:00.000Z');

const tokenClientKey = (clientId: string) =>
  `oauth:token:client:${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;

const importApp = async (
  rateLimiter: ReturnType<typeof vi.fn> = vi.fn(async () => ({ allowed: true, remaining: 1, resetAt })),
) => {
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

  it('disables DCR by default in production', async () => {
    process.env.NODE_ENV = 'production';
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.19',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['https://client.example/cb'],
      }),
    }, {
      incoming: { socket: { remoteAddress: '198.51.100.19' } },
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'registration_disabled' });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:register:198.51.100.19', 10, 3600);
  });

  it('allows DCR in production when OAUTH_DCR_ENABLED=true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OAUTH_DCR_ENABLED = 'true';
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.21',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['https://client.example/cb'],
      }),
    }, {
      incoming: { socket: { remoteAddress: '198.51.100.21' } },
    });

    expect(res.status).toBe(200);
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:register:198.51.100.21', 10, 3600);
  });

  it('returns 413 for oversized POST /oauth/reg bodies before provider bridge', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.11',
      },
      body: JSON.stringify({ client_name: 'a'.repeat(65 * 1024), redirect_uris: ['https://client.example/cb'] }),
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'registration request body too large',
    });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:register:203.0.113.11', 10, 3600);
  });

  it('rejects DCR metadata with too many redirect URIs', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.12',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: Array.from({ length: 11 }, (_, i) => `https://client.example/cb/${i}`),
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'too many redirect_uris; maximum is 10',
    });
  });

  it('rejects DCR metadata with unsupported scopes', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.13',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['https://client.example/cb'],
        scope: 'openid offline_access admin:all',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'unsupported scope: admin:all',
    });
  });

  it('rejects confidential DCR token endpoint auth methods', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.14',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['http://127.0.0.1:31111/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'token_endpoint_auth_method must be none',
    });
  });

  it('rejects unsupported DCR grant and response types', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const grantRes = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.15',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['https://client.example/cb'],
        grant_types: ['authorization_code', 'client_credentials'],
      }),
    });
    expect(grantRes.status).toBe(400);
    await expect(grantRes.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'unsupported grant_type: client_credentials',
    });

    const responseRes = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.15',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['https://client.example/cb'],
        response_types: ['code token'],
      }),
    });
    expect(responseRes.status).toBe(400);
    await expect(responseRes.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'unsupported response_type: code token',
    });
  });

  it('rejects DCR remote key and request metadata', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.16',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['https://client.example/cb'],
        jwks_uri: 'https://client.example/jwks.json',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'jwks_uri is not supported',
    });
  });

  it('applies the same DCR metadata policy to registration-management updates', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg/client-1', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.17',
      },
      body: JSON.stringify({
        client_name: 'oauth-flow-test',
        redirect_uris: ['https://client.example/cb'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks_uri: 'https://client.example/jwks.json',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'jwks_uri is not supported',
    });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:register:203.0.113.17', 10, 3600);
  });

  it('rate-limits registration-management deletes', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: false, remaining: 0, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg/client-1', {
      method: 'DELETE',
      headers: { 'x-forwarded-for': '203.0.113.18' },
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:register:203.0.113.18', 10, 3600);
  });

  it('rate-limits registration-management lookups', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: false, remaining: 0, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg/client-1', {
      method: 'GET',
      headers: { 'x-forwarded-for': '203.0.113.22' },
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:register:203.0.113.22', 10, 3600);
  });

  it('keys POST /oauth/token by IP and client_id when client_id is present', async () => {
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
    expect(rateLimiter).toHaveBeenNthCalledWith(1, null, 'oauth:token:ip:203.0.113.20', 60, 60);
    expect(rateLimiter).toHaveBeenNthCalledWith(2, null, tokenClientKey('foo'), 30, 60);
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
    expect(rateLimiter).toHaveBeenCalledTimes(1);
  });

  it('ignores forwarded IP headers in production when TRUST_PROXY_HEADERS=false', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY_HEADERS = 'false';
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 59, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.200',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    }, {
      incoming: { socket: { remoteAddress: '198.51.100.44' } },
    } as any);

    expect(res.status).toBe(200);
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:token:ip:198.51.100.44', 60, 60);
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

  it('returns 429 on the 31st POST /oauth/token for the same client_id', async () => {
    const rateLimiter = vi.fn(async (_redis, key: string) => {
      if (key.startsWith('oauth:token:client:')) {
        const clientCalls = rateLimiter.mock.calls.filter(([, calledKey]) =>
          String(calledKey).startsWith('oauth:token:client:'),
        ).length;
        return { allowed: clientCalls < 31, remaining: 0, resetAt };
      }
      return { allowed: true, remaining: 59, resetAt };
    });
    const app = await importApp(rateLimiter);

    for (let i = 0; i < 30; i++) {
      const res = await app.request('/oauth/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '203.0.113.36',
        },
        body: new URLSearchParams({ client_id: 'client-1', grant_type: 'authorization_code' }),
      });
      expect(res.status).toBe(200);
    }

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.36',
      },
      body: new URLSearchParams({ client_id: 'client-1', grant_type: 'authorization_code' }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(rateLimiter).toHaveBeenLastCalledWith(null, tokenClientKey('client-1'), 30, 60);
  });

  it('returns 413 for oversized POST /oauth/token bodies before provider bridge', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 59, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.38',
      },
      body: `client_id=${'a'.repeat(65 * 1024)}`,
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'token request body too large',
    });
    expect(rateLimiter).toHaveBeenCalledWith(null, 'oauth:token:ip:203.0.113.38', 60, 60);
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

  it('returns 400 when DCR receives malformed JSON (does not silently treat as empty)', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 9, resetAt }));
    const app = await importApp(rateLimiter);

    const res = await app.request('/oauth/reg', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.70',
      },
      body: '{not-json',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_client_metadata',
      error_description: 'malformed JSON',
    });
  });

  it('preserves token rawBody for the oidc-provider bridge to replay (production node path)', async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true, remaining: 59, resetAt }));
    const app = await importApp(rateLimiter);

    // Simulate a real Node IncomingMessage (with .on()) so the route uses
    // the rawBody pre-buffer path. Hono's app.request accepts an env arg
    // whose `incoming` becomes c.env.incoming.
    const bodyStr = 'client_id=node-client&grant_type=authorization_code';
    const dataChunks: Buffer[] = [Buffer.from(bodyStr, 'utf8')];
    const listeners: Record<string, ((...a: any[]) => void)[]> = { data: [], end: [], error: [] };
    const incoming = {
      headers: { 'content-length': String(Buffer.byteLength(bodyStr)) },
      rawBody: undefined as Buffer | undefined,
      on(ev: string, fn: any) { listeners[ev]?.push(fn); return this; },
      once(ev: string, fn: any) { listeners[ev]?.push(fn); return this; },
      removeListener() { return this; },
      socket: { remoteAddress: '198.51.100.99' },
    } as any;
    // Drive the stream after the route subscribes. We schedule via
    // setImmediate so listeners are attached first.
    setImmediate(() => {
      for (const c of dataChunks) listeners.data?.forEach((l) => l(c));
      listeners.end?.forEach((l) => l());
    });

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.71',
      },
      body: bodyStr,
    }, { incoming } as any);

    expect(res.status).toBe(200);
    // Per-client RL was keyed by the parsed client_id.
    expect(rateLimiter).toHaveBeenCalledWith(null, tokenClientKey('node-client'), 30, 60);
    // rawBody is set for the bridge to replay (downstream readability).
    expect(incoming.rawBody).toBeInstanceOf(Buffer);
    expect((incoming.rawBody as Buffer).toString('utf8')).toBe(bodyStr);
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
