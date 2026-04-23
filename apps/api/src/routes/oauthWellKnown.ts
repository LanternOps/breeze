import { Hono } from 'hono';
import { MCP_OAUTH_ENABLED, OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { loadJwks } from '../oauth/keys';

export const wellKnownRoutes = new Hono();

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'r', 't', 'k'] as const;

function stripPrivateJwkFields(jwk: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(jwk)) {
    if ((PRIVATE_JWK_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

if (MCP_OAUTH_ENABLED) {
  wellKnownRoutes.get('/oauth-authorization-server', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      issuer: OAUTH_ISSUER,
      authorization_endpoint: `${OAUTH_ISSUER}/oauth/auth`,
      token_endpoint: `${OAUTH_ISSUER}/oauth/token`,
      registration_endpoint: `${OAUTH_ISSUER}/oauth/reg`,
      revocation_endpoint: `${OAUTH_ISSUER}/oauth/token/revocation`,
      introspection_endpoint: `${OAUTH_ISSUER}/oauth/token/introspection`,
      jwks_uri: `${OAUTH_ISSUER}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: ['openid', 'offline_access', 'mcp:read', 'mcp:write'],
      resource_indicators_supported: true,
    });
  });

  wellKnownRoutes.get('/oauth-protected-resource', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      resource: OAUTH_RESOURCE_URL,
      authorization_servers: [OAUTH_ISSUER],
      scopes_supported: ['mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
    });
  });

  wellKnownRoutes.get('/jwks.json', async (c) => {
    const jwks = await loadJwks();
    const publicOnly = { keys: jwks.keys.map((k) => stripPrivateJwkFields(k as Record<string, unknown>)) };
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(publicOnly);
  });
}
