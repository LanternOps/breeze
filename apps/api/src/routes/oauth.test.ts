import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { Readable } from 'node:stream';

const ENV_KEYS = [
  'MCP_OAUTH_ENABLED',
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE_URL',
  'OAUTH_COOKIE_SECRET',
  'OAUTH_JWKS_PRIVATE_JWK',
] as const;

const clearEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

describe('oauthRoutes', () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    vi.doUnmock('../oauth/provider');
  });

  it('does not mount the catch-all when MCP_OAUTH_ENABLED is false', async () => {
    const { oauthRoutes } = await import('./oauth');
    const app = new Hono().route('/oauth', oauthRoutes);
    const res = await app.request('/oauth/anything', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('mounts a catch-all when MCP_OAUTH_ENABLED is true (provider call deferred)', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    vi.doMock('../oauth/provider', () => ({
      getProvider: vi.fn(async () => {
        throw new Error('provider not ready in this smoke test');
      }),
    }));
    vi.resetModules();

    const { oauthRoutes } = await import('./oauth');
    const app = new Hono().route('/oauth', oauthRoutes);
    const res = await app.request('/oauth/anything', { method: 'GET' });
    expect(res.status).toBe(500);
  });
});

describe('oauthRoutes — resource-indicator alias normalization (#2363)', () => {
  const RESOURCE = 'https://region.example/api/v1/mcp';

  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    vi.doUnmock('../oauth/provider');
    vi.doUnmock('../services/redis');
    vi.doUnmock('../services/rate-limit');
  });

  /**
   * Build the routes with MCP OAuth enabled, the provider bridge mocked to
   * throw a sentinel (the pre-handler under test runs BEFORE the bridge),
   * and Redis/rate-limit mocked so the /token and /auth limiter branches
   * don't need infrastructure.
   */
  const importApp = async (): Promise<Hono> => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    process.env.OAUTH_RESOURCE_URL = RESOURCE;
    vi.doMock('../oauth/provider', () => ({
      getProvider: vi.fn(async () => {
        throw new Error('bridge sentinel');
      }),
    }));
    vi.doMock('../services/redis', () => ({ getRedis: vi.fn(() => null) }));
    vi.doMock('../services/rate-limit', () => ({
      rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
    }));
    vi.resetModules();
    const { oauthRoutes } = await import('./oauth');
    return new Hono().route('/oauth', oauthRoutes);
  };

  /** Fake Node IncomingMessage: a real Readable plus headers/url. */
  const fakeIncoming = (opts: { body?: string; url?: string }) => {
    const stream = (opts.body !== undefined
      ? Readable.from([Buffer.from(opts.body, 'utf8')])
      : Readable.from([])) as unknown as NodeJS.ReadableStream & {
      headers: Record<string, string>;
      url?: string;
      rawBody?: Buffer;
      body?: Buffer;
    };
    stream.headers = opts.body !== undefined
      ? { 'content-length': String(Buffer.byteLength(opts.body, 'utf8')) }
      : {};
    if (opts.url !== undefined) stream.url = opts.url;
    return stream;
  };

  it('rewrites an /sse-alias resource in the token body to the canonical resource before the bridge', async () => {
    const app = await importApp();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-1',
      resource: `${RESOURCE}/sse`,
    }).toString();
    const incoming = fakeIncoming({ body });

    const res = await app.request(
      '/oauth/token',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { incoming },
    );

    // Bridge sentinel → 500; the pre-handler already ran and rewrote the
    // buffered body the bridge would replay.
    expect(res.status).toBe(500);
    expect(incoming.rawBody).toBeDefined();
    const replayed = new URLSearchParams(incoming.rawBody!.toString('utf8'));
    expect(replayed.get('resource')).toBe(RESOURCE);
    expect(replayed.get('refresh_token')).toBe('rt-1');
    expect(incoming.body!.toString('utf8')).toBe(incoming.rawBody!.toString('utf8'));
    expect(incoming.headers['content-length']).toBe(String(incoming.rawBody!.byteLength));
  });

  it('leaves an unrelated resource untouched in the token body (still fails invalid_target downstream)', async () => {
    const app = await importApp();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-1',
      resource: 'https://evil.example/api/v1/mcp',
    }).toString();
    const incoming = fakeIncoming({ body });

    await app.request(
      '/oauth/token',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { incoming },
    );

    expect(incoming.rawBody!.toString('utf8')).toBe(body);
    const replayed = new URLSearchParams(incoming.rawBody!.toString('utf8'));
    expect(replayed.get('resource')).toBe('https://evil.example/api/v1/mcp');
  });

  it('rewrites an alias resource in the authorization request query before the bridge reads incoming.url', async () => {
    const app = await importApp();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'client-1',
      scope: 'openid offline_access mcp:read',
      resource: `${RESOURCE}/sse`,
    }).toString();
    const incoming = fakeIncoming({ url: `/oauth/auth?${query}` });

    const res = await app.request(`/oauth/auth?${query}`, { method: 'GET' }, { incoming });

    expect(res.status).toBe(500); // bridge sentinel
    const rewritten = new URLSearchParams(incoming.url!.split('?')[1]);
    expect(rewritten.get('resource')).toBe(RESOURCE);
    expect(rewritten.get('scope')).toBe('openid offline_access mcp:read');
    expect(incoming.url!.startsWith('/oauth/auth?')).toBe(true);
  });

  it('does not touch the authorization URL when the resource is already canonical', async () => {
    const app = await importApp();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'client-1',
      resource: RESOURCE,
    }).toString();
    const url = `/oauth/auth?${query}`;
    const incoming = fakeIncoming({ url });

    await app.request(url, { method: 'GET' }, { incoming });

    expect(incoming.url).toBe(url);
  });
});
