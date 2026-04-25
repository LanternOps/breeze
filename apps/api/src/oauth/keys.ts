import { OAUTH_JWKS_PRIVATE_JWK } from '../config/env';

export interface JWKS {
  keys: Record<string, unknown>[];
}

export async function loadJwks(): Promise<JWKS> {
  if (!OAUTH_JWKS_PRIVATE_JWK) {
    throw new Error('OAUTH_JWKS_PRIVATE_JWK env var is required when MCP_OAUTH_ENABLED is true');
  }
  const parsed = JSON.parse(OAUTH_JWKS_PRIVATE_JWK);
  const jwks = Array.isArray(parsed.keys) ? { keys: parsed.keys } : { keys: [parsed] };
  validatePrivateSigningJwks(jwks);
  return jwks;
}

function validatePrivateSigningJwks(jwks: { keys: unknown[] }): asserts jwks is JWKS {
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error('OAUTH_JWKS_PRIVATE_JWK must contain at least one private signing JWK');
  }

  const kids = new Set<string>();
  jwks.keys.forEach((key, index) => {
    if (!key || typeof key !== 'object' || Array.isArray(key)) {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK key at index ${index} must be a JWK object`);
    }
    const jwk = key as Record<string, unknown>;
    const kid = jwk.kid;
    if (typeof kid !== 'string' || kid.trim().length === 0) {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK key at index ${index} must include a non-empty kid`);
    }
    if (kids.has(kid)) {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK contains duplicate kid: ${kid}`);
    }
    kids.add(kid);

    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK key ${kid} must be an Ed25519 OKP key`);
    }
    if (jwk.alg !== undefined && jwk.alg !== 'EdDSA') {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK key ${kid} must use alg EdDSA`);
    }
    if (jwk.use !== undefined && jwk.use !== 'sig') {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK key ${kid} must use sig`);
    }
    if (typeof jwk.d !== 'string' || jwk.d.length === 0) {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK key ${kid} must include private signing material`);
    }
    if (typeof jwk.x !== 'string' || jwk.x.length === 0) {
      throw new Error(`OAUTH_JWKS_PRIVATE_JWK key ${kid} must include public key material`);
    }
  });
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
