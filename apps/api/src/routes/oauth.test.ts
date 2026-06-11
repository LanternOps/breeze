import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

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
