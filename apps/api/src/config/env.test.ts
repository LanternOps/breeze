import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadEnv = async () => import('./env');

describe('config env', () => {
  beforeEach(() => {
    delete process.env.MCP_OAUTH_ENABLED;
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_RESOURCE_URL;
    delete process.env.OAUTH_JWKS_PRIVATE_JWK;
    delete process.env.OAUTH_JWKS_PUBLIC_JWK;
    delete process.env.OAUTH_COOKIE_SECRET;
    vi.resetModules();
  });

  it('defaults MCP_OAUTH_ENABLED to false when unset', async () => {
    const mod = await loadEnv();
    expect(mod.MCP_OAUTH_ENABLED).toBe(false);
  });

  it('treats recognized true values as enabled', async () => {
    for (const value of ['true', '1', 'yes', 'on']) {
      process.env.MCP_OAUTH_ENABLED = value;
      vi.resetModules();
      const mod = await loadEnv();
      expect(mod.MCP_OAUTH_ENABLED).toBe(true);
    }
  });

  it('treats unrecognized MCP_OAUTH_ENABLED values as false', async () => {
    process.env.MCP_OAUTH_ENABLED = 'foo';
    const mod = await loadEnv();
    expect(mod.MCP_OAUTH_ENABLED).toBe(false);
  });

  it('defaults OAUTH_ISSUER and derives OAUTH_RESOURCE_URL', async () => {
    const mod = await loadEnv();
    expect(mod.OAUTH_ISSUER).toBe('https://us.2breeze.app');
    expect(mod.OAUTH_RESOURCE_URL).toBe('https://us.2breeze.app/mcp/server');
  });

  it('allows OAUTH_RESOURCE_URL to override the derived value', async () => {
    process.env.OAUTH_ISSUER = 'https://issuer.example';
    process.env.OAUTH_RESOURCE_URL = 'https://resource.example/custom';
    const mod = await loadEnv();
    expect(mod.OAUTH_RESOURCE_URL).toBe('https://resource.example/custom');
  });
});
