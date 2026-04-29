function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const MCP_OAUTH_ENABLED = envFlag('MCP_OAUTH_ENABLED');

// Read at call time so tests can flip `MCP_BOOTSTRAP_ENABLED` per-test without `vi.resetModules()`.
export function isMcpBootstrapEnabled(): boolean {
  return envFlag('MCP_BOOTSTRAP_ENABLED');
}
export const OAUTH_DCR_ENABLED = envFlag('OAUTH_DCR_ENABLED', process.env.NODE_ENV !== 'production');
export const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? '';
export const OAUTH_RESOURCE_URL = process.env.OAUTH_RESOURCE_URL ?? '';
// Optional override for the consent UI base. Defaults to '' (relative path)
// — in prod the API and web share the same origin behind Caddy, so a
// relative redirect works. In local dev where API and web run on different
// ports, set this to e.g. http://localhost:4321 so the browser navigates
// to the web origin instead of the API origin.
export const OAUTH_CONSENT_URL_BASE = process.env.OAUTH_CONSENT_URL_BASE ?? '';
export const OAUTH_JWKS_PRIVATE_JWK = process.env.OAUTH_JWKS_PRIVATE_JWK ?? '';
export const OAUTH_JWKS_PUBLIC_JWK = process.env.OAUTH_JWKS_PUBLIC_JWK ?? '';
export const OAUTH_COOKIE_SECRET = process.env.OAUTH_COOKIE_SECRET ?? '';
