function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const MCP_OAUTH_ENABLED = envFlag('MCP_OAUTH_ENABLED');
export const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? 'https://us.2breeze.app';
export const OAUTH_RESOURCE_URL =
  process.env.OAUTH_RESOURCE_URL ?? `${process.env.OAUTH_ISSUER ?? 'https://us.2breeze.app'}/mcp/server`;
export const OAUTH_JWKS_PRIVATE_JWK = process.env.OAUTH_JWKS_PRIVATE_JWK ?? '';
export const OAUTH_JWKS_PUBLIC_JWK = process.env.OAUTH_JWKS_PUBLIC_JWK ?? '';
export const OAUTH_COOKIE_SECRET = process.env.OAUTH_COOKIE_SECRET ?? '';
