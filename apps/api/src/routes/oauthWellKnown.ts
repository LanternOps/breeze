import { Hono } from 'hono';
import { MCP_OAUTH_ENABLED, OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { loadPublicJwks } from '../oauth/keys';

export const wellKnownRoutes = new Hono();

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
      token_endpoint_auth_methods_supported: ['none'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      scopes_supported: ['openid', 'offline_access', 'mcp:read', 'mcp:write', 'mcp:execute'],
      resource_indicators_supported: true,
    });
  });

  wellKnownRoutes.get('/oauth-protected-resource', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      resource: OAUTH_RESOURCE_URL,
      authorization_servers: [OAUTH_ISSUER],
      scopes_supported: ['mcp:read', 'mcp:write', 'mcp:execute'],
      bearer_methods_supported: ['header'],
    });
  });

  wellKnownRoutes.get('/jwks.json', async (c) => {
    const publicJwks = await loadPublicJwks();
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(publicJwks);
  });
}
