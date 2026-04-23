// @ts-expect-error oidc-provider v8.8.1 does not publish TypeScript declarations.
import Provider from 'oidc-provider';
import { OAUTH_COOKIE_SECRET, OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { BreezeOidcAdapter } from './adapter';
import { findAccount } from './findAccount';
import { loadJwks } from './keys';

let providerInstance: Provider | null = null;

export async function getProvider(): Promise<Provider> {
  if (providerInstance) return providerInstance;
  if (!OAUTH_COOKIE_SECRET) {
    throw new Error('OAUTH_COOKIE_SECRET is required when MCP_OAUTH_ENABLED is true (set a strong random string in env)');
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
    pkce: { required: () => true, methods: ['S256'] },
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
  return providerInstance;
}
