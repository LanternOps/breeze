import { OAUTH_JWKS_PRIVATE_JWK } from '../config/env';

export interface JWKS {
  keys: any[];
}

export async function loadJwks(): Promise<JWKS> {
  if (!OAUTH_JWKS_PRIVATE_JWK) {
    throw new Error('OAUTH_JWKS_PRIVATE_JWK env var is required when MCP_OAUTH_ENABLED is true');
  }
  const parsed = JSON.parse(OAUTH_JWKS_PRIVATE_JWK);
  return Array.isArray(parsed.keys) ? parsed : { keys: [parsed] };
}
