import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose';

/**
 * Cloudflare Access JWT verification.
 *
 * When a self-hoster sits Breeze behind Cloudflare Access with the same IdP
 * that Breeze itself is configured with, the user authenticates twice: once at
 * the CF Access edge, once at the Breeze login form. This service lets a
 * deployment opt into trusting the CF Access JWT and short-circuiting Breeze's
 * password handler when a valid one is presented (see Discussion #702).
 *
 * Cloudflare Access JWT shape per
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/:
 *
 *   {
 *     "aud":      "<application-aud>",
 *     "email":    "user@example.com",
 *     "exp":      1234567890,
 *     "iat":      1234567890,
 *     "nbf":      1234567890,
 *     "iss":      "https://<team>.cloudflareaccess.com",
 *     "type":     "app" | "warp",
 *     "identity_nonce": "...",
 *     "sub":      "<cf-internal-user-id>",
 *     "country":  "US"
 *   }
 *
 * Notable absence: no MFA / auth-method claim. Whether the underlying CF
 * Access policy required MFA is an operator-level assertion, not something
 * the verifier can derive from the JWT itself. The caller decides via the
 * `CF_ACCESS_TRUSTS_MFA` env flag whether to treat a valid JWT as
 * MFA-satisfied for the minted Breeze session.
 */

export interface CfAccessJwtClaims {
  email: string;
  aud: string | string[];
  iss: string;
  sub: string;
  exp: number;
  iat: number;
  nbf?: number;
  type?: string;
  identity_nonce?: string;
  country?: string;
}

export interface CfAccessVerifyConfig {
  /** Cloudflare team domain, e.g. `your-team.cloudflareaccess.com` (no scheme). */
  teamDomain: string;
  /** Allowed audiences. Currently a one-element set per Discussion #702 decision; plumbed as set for future multi-AUD. */
  audience: string | readonly string[];
}

export class CfAccessJwksUnavailableError extends Error {
  override readonly name = 'CfAccessJwksUnavailableError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class CfAccessInvalidTokenError extends Error {
  override readonly name = 'CfAccessInvalidTokenError';
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const ALLOWED_ALGS = ['RS256'] as const;

let cachedConfigKey = '';
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function jwksUrl(teamDomain: string): URL {
  return new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
}

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  // Re-create the JWKS set when the team domain changes (e.g. tests, hot
  // reconfig). In normal operation `teamDomain` is fixed by env and this
  // function returns the same cached set for the lifetime of the process.
  if (cachedConfigKey !== teamDomain || cachedJwks === null) {
    cachedJwks = createRemoteJWKSet(jwksUrl(teamDomain), {
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes; jose refreshes on `kid` miss
      cooldownDuration: 30 * 1000,
    });
    cachedConfigKey = teamDomain;
  }
  return cachedJwks;
}

/**
 * Test-only: reset the JWKS cache so a subsequent call rebuilds it. Production
 * callers never need this.
 */
export function _resetCfAccessJwksCacheForTests(): void {
  cachedConfigKey = '';
  cachedJwks = null;
}

/**
 * Verify a Cloudflare Access JWT and return its claims.
 *
 * Throws `CfAccessInvalidTokenError` on signature failure, bad issuer/audience,
 * expired/not-yet-valid token, or any other token-shape problem (jose `ERR_*`
 * codes). Throws `CfAccessJwksUnavailableError` on JWKS fetch failures
 * (network errors talking to `/cdn-cgi/access/certs`). The caller decides
 * what to do with each. For the login short-circuit, both cases fall through
 * to the password handler, but they're surfaced as distinct types so other
 * callers (e.g. a future strictly-CF-Access-only deploy mode) can fail closed
 * if they want.
 */
export async function verifyCfAccessJwt(
  token: string,
  config: CfAccessVerifyConfig,
): Promise<CfAccessJwtClaims> {
  const expectedIssuer = `https://${config.teamDomain}`;
  const audience: string | string[] = typeof config.audience === 'string'
    ? config.audience
    : [...config.audience];

  let result: JWTVerifyResult;
  try {
    result = await jwtVerify(token, getJwks(config.teamDomain), {
      issuer: expectedIssuer,
      audience,
      algorithms: [...ALLOWED_ALGS],
      requiredClaims: ['exp', 'iat', 'email', 'aud', 'iss', 'sub'],
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const isJoseError = typeof code === 'string' && code.startsWith('ERR_');
    if (!isJoseError) {
      // Anything without a jose ERR_* code is a network/IO problem talking
      // to JWKS. Distinct error type so the caller can fail-open on
      // availability while still failing-closed on signature/claim
      // validity (per Discussion #702 maintainer decision).
      throw new CfAccessJwksUnavailableError(
        `Failed to verify Cloudflare Access JWT: ${(err as Error).message ?? 'unknown error'}`,
        err,
      );
    }
    throw new CfAccessInvalidTokenError(
      `Cloudflare Access JWT rejected: ${code}`,
      code,
    );
  }

  const payload = result.payload as JWTPayload;
  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!email) {
    throw new CfAccessInvalidTokenError(
      'Cloudflare Access JWT missing email claim',
      'ERR_JWT_CLAIM_VALIDATION_FAILED',
    );
  }

  return {
    email,
    aud: payload.aud as string | string[],
    iss: payload.iss as string,
    sub: payload.sub as string,
    exp: payload.exp as number,
    iat: payload.iat as number,
    nbf: typeof payload.nbf === 'number' ? payload.nbf : undefined,
    type: typeof payload.type === 'string' ? payload.type : undefined,
    identity_nonce:
      typeof payload.identity_nonce === 'string' ? payload.identity_nonce : undefined,
    country: typeof payload.country === 'string' ? payload.country : undefined,
  };
}
