import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadEnv = async () => import('./env');

const OAUTH_ENV_KEYS = [
  'MCP_OAUTH_ENABLED',
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE_URL',
  'OAUTH_JWKS_PRIVATE_JWK',
  'OAUTH_JWKS_PUBLIC_JWK',
  'OAUTH_COOKIE_SECRET',
] as const;

const clearOauthEnv = () => {
  for (const key of OAUTH_ENV_KEYS) delete process.env[key];
};

describe('config env', () => {
  beforeEach(() => {
    clearOauthEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearOauthEnv();
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

  it('defaults OAUTH_ISSUER and OAUTH_RESOURCE_URL to empty strings', async () => {
    const mod = await loadEnv();
    expect(mod.OAUTH_ISSUER).toBe('');
    expect(mod.OAUTH_RESOURCE_URL).toBe('');
  });

  it('allows OAUTH_RESOURCE_URL to override the derived value', async () => {
    process.env.OAUTH_ISSUER = 'https://issuer.example';
    process.env.OAUTH_RESOURCE_URL = 'https://resource.example/custom';
    const mod = await loadEnv();
    expect(mod.OAUTH_RESOURCE_URL).toBe('https://resource.example/custom');
  });
});
