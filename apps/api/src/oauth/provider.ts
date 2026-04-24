import Provider from 'oidc-provider';
import { OAUTH_COOKIE_SECRET, OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { BreezeOidcAdapter } from './adapter';
import { findAccount } from './findAccount';
import { loadJwks } from './keys';
import { revokeJti } from './revocationCache';

let providerInstance: Provider | null = null;

export async function getProvider(): Promise<Provider> {
  if (providerInstance) return providerInstance;
  if (!OAUTH_COOKIE_SECRET) {
    throw new Error('OAUTH_COOKIE_SECRET is required when MCP_OAUTH_ENABLED is true (set a strong random string in env)');
  }
  if (!OAUTH_ISSUER) {
    throw new Error('OAUTH_ISSUER is required when MCP_OAUTH_ENABLED is true (set the issuer URL in env)');
  }
  if (!OAUTH_RESOURCE_URL) {
    throw new Error('OAUTH_RESOURCE_URL is required when MCP_OAUTH_ENABLED is true (typically `${OAUTH_ISSUER}/mcp/server`)');
  }

  const jwks = await loadJwks();

  providerInstance = new Provider(OAUTH_ISSUER, {
    adapter: BreezeOidcAdapter,
    clients: [],
    jwks,
    cookies: { keys: [OAUTH_COOKIE_SECRET] },
    findAccount,
    enabledJWA: {
      idTokenSigningAlgValues: ['EdDSA', 'RS256'],
      requestObjectSigningAlgValues: ['EdDSA', 'RS256'],
      userinfoSigningAlgValues: ['EdDSA', 'RS256'],
      introspectionSigningAlgValues: ['EdDSA', 'RS256'],
      authorizationSigningAlgValues: ['EdDSA', 'RS256'],
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, initialAccessToken: false },
      registrationManagement: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => OAUTH_RESOURCE_URL,
        getResourceServerInfo: (_ctx: any, resource: string) => ({
          scope: 'mcp:read mcp:write',
          accessTokenFormat: 'jwt' as const,
          accessTokenTTL: 600,
          audience: resource,
          jwt: { sign: { alg: 'EdDSA' as const } },
        }),
        useGrantedResource: (_ctx: any, _model: any) => true,
      },
    },
    scopes: ['openid', 'offline_access', 'mcp:read', 'mcp:write'],
    // S256 is the only PKCE method supported in oidc-provider v8 (the spec
    // dropped `plain`); pass only `required`.
    pkce: { required: () => true },
    ttl: {
      AccessToken: 600,
      AuthorizationCode: 600,
      RefreshToken: 60 * 24 * 60 * 60,
      Session: 14 * 24 * 60 * 60,
      Interaction: 60 * 60,
      Grant: 14 * 24 * 60 * 60,
    },
    claims: {
      openid: ['sub'],
      profile: ['name', 'email'],
      breeze_tenant: ['partner_id', 'org_id'],
    },
    extraTokenClaims: async (ctx: any, _token: any) => {
      const grant: any = ctx.oidc?.entities?.Grant;
      if (!grant) return {};
      const meta = grant.breeze ?? {};
      return {
        partner_id: meta.partner_id ?? null,
        org_id: meta.org_id ?? null,
      };
    },
    interactions: {
      url: (_ctx: any, interaction: any) => `/oauth/consent?uid=${interaction.uid}`,
    },
  });

  providerInstance.proxy = true;
  (providerInstance as any).on('revocation.success', (_ctx: any, token: any) => {
    if (!token.jti || !token.exp) return;
    const ttl = Math.max(token.exp - Math.floor(Date.now() / 1000), 1);
    revokeJti(token.jti, ttl).catch((err) => {
      console.error('[oauth] revocation cache write failed', err);
    });
  });
  return providerInstance;
}
