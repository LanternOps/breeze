import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose';

/**
 * Entra ID (Azure AD) access-token verification for Breeze AI for Office.
 *
 * The Excel add-in acquires a token via Office SSO / NAA in the END CUSTOMER's
 * tenant and posts it to POST /client-ai/auth/exchange (spec §3). This service
 * verifies it:
 *
 *   - signature against Microsoft's COMMON JWKS (multi-tenant app — keys are
 *     shared across tenants, the issuer is not),
 *   - audience pinned to our app registration (CLIENT_AI_ENTRA_CLIENT_ID),
 *   - expiry / algorithm via jose,
 *   - issuer bound to the token's OWN tid claim
 *     (https://login.microsoftonline.com/{tid}/v2.0) — prevents a token from
 *     tenant A presenting itself as tenant B, which would be a cross-org
 *     mapping bypass.
 *
 * Modeled on services/cfAccessJwt.ts (error taxonomy, JWKS caching, test
 * seams). Distinct from services/c2cM365.ts, which is client-credentials
 * APP-token acquisition, not user-token verification.
 */

export interface ClientAiEntraClaims {
  /** Entra tenant id (GUID, lowercased). */
  tid: string;
  /** Entra object id of the user within the tenant (GUID, lowercased). */
  oid: string;
  /** Best-effort email (preferred_username when address-shaped, else email claim), lowercased. */
  email: string | null;
  /** Display name when present. */
  name: string | null;
  aud: string | string[];
  iss: string;
  exp: number;
  iat: number;
}

export class ClientAiEntraJwksUnavailableError extends Error {
  override readonly name = 'ClientAiEntraJwksUnavailableError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class ClientAiEntraInvalidTokenError extends Error {
  override readonly name = 'ClientAiEntraInvalidTokenError';
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const ENTRA_COMMON_JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const ENTRA_GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ALGS = ['RS256'] as const;

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks === null) {
    cachedJwks = createRemoteJWKSet(new URL(ENTRA_COMMON_JWKS_URL), {
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes; jose refreshes on `kid` miss
      cooldownDuration: 30 * 1000,
    });
  }
  return cachedJwks;
}

/** Test-only: reset the JWKS cache so a subsequent call rebuilds it. */
export function _resetClientAiEntraJwksCacheForTests(): void {
  cachedJwks = null;
}

function invalid(message: string, code = 'ERR_JWT_CLAIM_VALIDATION_FAILED'): never {
  throw new ClientAiEntraInvalidTokenError(message, code);
}

export async function verifyEntraIdToken(
  token: string,
  config: { audience: string },
): Promise<ClientAiEntraClaims> {
  let result: JWTVerifyResult;
  try {
    result = await jwtVerify(token, getJwks(), {
      audience: config.audience,
      algorithms: [...ALLOWED_ALGS],
      // No `issuer` option: the v2.0 issuer is per-tenant and we don't know the
      // tenant until we read the (signature-verified) tid claim below.
      requiredClaims: ['exp', 'iat', 'aud', 'iss', 'tid', 'oid'],
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const isJoseError = typeof code === 'string' && code.startsWith('ERR_');
    if (!isJoseError) {
      // No jose ERR_* code => network/IO problem reaching the JWKS endpoint.
      // Distinct type so the exchange route can 503 instead of 401.
      throw new ClientAiEntraJwksUnavailableError(
        `Failed to verify Entra ID token: ${(err as Error).message ?? 'unknown error'}`,
        err,
      );
    }
    throw new ClientAiEntraInvalidTokenError(`Entra ID token rejected: ${code}`, code);
  }

  const payload = result.payload as JWTPayload & {
    tid?: unknown;
    oid?: unknown;
    preferred_username?: unknown;
    email?: unknown;
    name?: unknown;
  };

  const tid = typeof payload.tid === 'string' ? payload.tid.toLowerCase() : '';
  const oid = typeof payload.oid === 'string' ? payload.oid.toLowerCase() : '';
  if (!ENTRA_GUID_REGEX.test(tid)) invalid('Entra ID token missing a valid tid claim');
  if (!ENTRA_GUID_REGEX.test(oid)) invalid('Entra ID token missing a valid oid claim');

  // Signature is already proven against Microsoft's common JWKS; binding iss to
  // the token's own tid closes the cross-tenant spoof.
  const expectedIssuer = `https://login.microsoftonline.com/${tid}/v2.0`;
  if (payload.iss !== expectedIssuer) {
    invalid(`Entra ID token issuer mismatch (expected ${expectedIssuer})`);
  }

  const preferred =
    typeof payload.preferred_username === 'string' && payload.preferred_username.includes('@')
      ? payload.preferred_username.toLowerCase()
      : null;
  const emailClaim =
    typeof payload.email === 'string' && payload.email.includes('@')
      ? payload.email.toLowerCase()
      : null;

  return {
    tid,
    oid,
    email: preferred ?? emailClaim,
    name: typeof payload.name === 'string' ? payload.name : null,
    aud: payload.aud as string | string[],
    iss: payload.iss as string,
    exp: payload.exp as number,
    iat: payload.iat as number,
  };
}
