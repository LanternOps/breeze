import { exportJWK, generateKeyPair } from 'jose';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ENV_KEYS = ['MCP_OAUTH_ENABLED', 'OAUTH_ISSUER', 'OAUTH_RESOURCE_URL', 'OAUTH_JWKS_PRIVATE_JWK'] as const;
const clearEnv = () => ENV_KEYS.forEach((key) => delete process.env[key]);
const loadApp = async () => new Hono().route('/.well-known', (await import('./oauthWellKnown')).wellKnownRoutes);
const generatedPrivateJwk = async () => {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { ...(await exportJWK(privateKey)), kid: 'test-key', alg: 'EdDSA', use: 'sig' };
};
describe('wellKnownRoutes', () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });
  afterEach(() => {
    clearEnv();
  });
  it('does not mount routes when MCP_OAUTH_ENABLED is false', async () => {
    const res = await (await loadApp()).request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(404);
  });

  it('serves OAuth authorization server metadata', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    process.env.OAUTH_ISSUER = 'https://auth.example';
    vi.resetModules();
    const res = await (await loadApp()).request('/.well-known/oauth-authorization-server');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(body).toMatchObject({
      issuer: 'https://auth.example',
      authorization_endpoint: 'https://auth.example/oauth/auth',
      token_endpoint: 'https://auth.example/oauth/token',
      registration_endpoint: 'https://auth.example/oauth/reg',
      revocation_endpoint: 'https://auth.example/oauth/token/revocation',
      introspection_endpoint: 'https://auth.example/oauth/token/introspection',
      jwks_uri: 'https://auth.example/.well-known/jwks.json',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      scopes_supported: ['openid', 'offline_access', 'mcp:read', 'mcp:write', 'mcp:execute'],
      resource_indicators_supported: true,
    });
  });
  it('serves OAuth protected resource metadata', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    process.env.OAUTH_ISSUER = 'https://auth.example';
    process.env.OAUTH_RESOURCE_URL = 'https://api.example/mcp/server';
    vi.resetModules();
    const res = await (await loadApp()).request('/.well-known/oauth-protected-resource');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(body).toEqual({
      resource: 'https://api.example/mcp/server',
      authorization_servers: ['https://auth.example'],
      scopes_supported: ['mcp:read', 'mcp:write', 'mcp:execute'],
      bearer_methods_supported: ['header'],
    });
  });
  it('serves public JWKS without private key material', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify(await generatedPrivateJwk());
    vi.resetModules();
    const res = await (await loadApp()).request('/.well-known/jwks.json');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('d');
  });
});
