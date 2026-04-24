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

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'r', 't', 'k'] as const;

/**
 * Strip RFC 7517 private-key fields from a JWK, leaving only the public
 * portion. Used by the /.well-known/jwks.json endpoint AND by any in-process
 * verifier that loads JWKS from `loadJwks()` (which returns the private set
 * because the provider needs it for signing). Passing a private JWK directly
 * to `createLocalJWKSet` throws ERR_JWKS_INVALID — jose enforces public-only
 * key sets to prevent leaking signing material via verification paths.
 */
export function stripPrivateJwkFields(jwk: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(jwk)) {
    if ((PRIVATE_JWK_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function loadPublicJwks(): Promise<JWKS> {
  const jwks = await loadJwks();
  return { keys: jwks.keys.map((k) => stripPrivateJwkFields(k as Record<string, unknown>)) };
}
