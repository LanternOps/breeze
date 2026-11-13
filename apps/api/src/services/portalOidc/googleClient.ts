/**
 * The customer portal's Google client (portal registration W7): authorize
 * URL, code exchange and id_token verification for "Sign in with Google".
 *
 * id_token rules (plan D1, spec §5.8, inv. 6), all enforced by
 * verifyPortalGoogleIdToken:
 *   - signature against Google's JWKS (10 min cache, 30 s cooldown; the W4
 *     options), RS256 only;
 *   - required `iss aud exp iat sub nonce email email_verified hd`; `iat` and
 *     `exp` numbers; clock tolerance 60 s; `iat` no older than 10 min and not
 *     more than the tolerance in the future;
 *   - `aud` a STRING equal to the portal client id. An array is refused even
 *     when it contains the id (jose's `audience` option alone would accept
 *     it). `azp`, when present, equals the client id too;
 *   - `iss` is `https://accounts.google.com` or `accounts.google.com` (Google
 *     documents both); the identity always carries `PORTAL_GOOGLE_ISSUER`;
 *   - `nonce` equal in constant time;
 *   - `sub` 1–255 printable ASCII characters, kept exactly as issued
 *     (case-sensitive, never normalized, not assumed numeric);
 *   - `email_verified === true` (the string "true" is refused);
 *   - `hd` present, lowercased, and a syntactically valid domain (the
 *     customer-domain rule of @breeze/shared). No `hd` → refused: a personal
 *     Gmail account and a consumer Google account created on a company
 *     address carry none, and Google is authoritative for an address only
 *     when the account is managed.
 * The authorize request's `hd=*` is an account-chooser hint only; nothing
 * here reads it back (inv. 2). The org is chosen later from the token's `hd`.
 *
 * Failures throw PortalGoogleTokenError(check). `check` names the failed step
 * for the server log only; nothing here logs or throws token, code, secret or
 * token-endpoint body content (W4 D14).
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';
import { createOrgCustomerDomainSchema } from '@breeze/shared';
import { PORTAL_GOOGLE_CALLBACK_PATH, type PortalGoogleConfig } from '../../config/portalGoogle';
import { addressClaim, errorDiagnostics, nonceMatches } from './tokenChecks';
import type { PortalGoogleVerifiedIdentity } from './types';
import { PORTAL_GOOGLE_ISSUER } from './validators';

export const PORTAL_GOOGLE_SIGN_IN_SCOPE = 'openid email profile';
export const PORTAL_GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const PORTAL_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PORTAL_GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** The two `iss` values Google documents for its ID tokens. */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(['https://accounts.google.com', 'accounts.google.com']);
const ID_TOKEN_MAX_AGE_SECONDS = 10 * 60;
const CLOCK_TOLERANCE_SECONDS = 60;
const TOKEN_ENDPOINT_TIMEOUT_MS = 15_000;
/** Printable ASCII, no space, 1–255 characters. */
const GOOGLE_SUBJECT = /^[\x21-\x7e]{1,255}$/;
const hostedDomainSchema = createOrgCustomerDomainSchema.shape.domain;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `check` is server-side diagnostics only; never token content. */
export class PortalGoogleTokenError extends Error {
  override readonly name = 'PortalGoogleTokenError';
  constructor(readonly check: string) {
    super('Google sign-in verification failed');
  }
}

function fail(check: string, extra: { status?: number; errorName?: string; errorCode?: string } = {}): never {
  console.warn('[portal] Google sign-in check failed', { check, ...extra });
  throw new PortalGoogleTokenError(check);
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getGoogleJwks(): ReturnType<typeof createRemoteJWKSet> {
  cachedJwks ??= createRemoteJWKSet(new URL(PORTAL_GOOGLE_JWKS_URL), {
    cacheMaxAge: 10 * 60 * 1000, // jose refreshes early on an unknown `kid`
    cooldownDuration: 30 * 1000,
  });
  return cachedJwks;
}

/**
 * Google's v2 authorize URL: code flow, PKCE S256, `prompt=select_account`,
 * `hd=*` (any managed account; a UI hint, never a check), `access_type=online`,
 * and the one fixed redirect URI (D10).
 */
export function buildPortalGoogleAuthorizeUrl(
  cfg: PortalGoogleConfig,
  input: { state: string; nonce: string; codeChallenge: string },
): string {
  const redirect = new URL(cfg.callbackUrl);
  if (redirect.pathname !== PORTAL_GOOGLE_CALLBACK_PATH || redirect.search || redirect.hash) {
    throw new Error('portal_google_invalid_redirect_uri');
  }
  if (!input.state || !input.nonce || !input.codeChallenge) {
    throw new Error('portal_google_incomplete_authorize_request');
  }
  const url = new URL(PORTAL_GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', PORTAL_GOOGLE_SIGN_IN_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('hd', '*');
  url.searchParams.set('access_type', 'online');
  return url.toString();
}

/**
 * Redeem an authorization code at Google's token endpoint with the client
 * secret (form body) and the PKCE verifier. Any failure (request error,
 * non-2xx, malformed body, no id_token) throws
 * PortalGoogleTokenError('token_endpoint') after logging the status only.
 * Only the id_token is returned: sign-in calls no Google API.
 */
export async function exchangePortalGoogleCode(
  cfg: PortalGoogleConfig,
  input: { code: string; codeVerifier: string },
  deps: { fetch?: typeof fetch } = {},
): Promise<{ idToken: string }> {
  if (!input.code || !input.codeVerifier) fail('token_request');

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.callbackUrl,
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
  });
  const fetchImpl: FetchLike = deps.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(PORTAL_GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_ENDPOINT_TIMEOUT_MS),
    });
  } catch (error) {
    fail('token_endpoint', errorDiagnostics(error));
  }
  if (!response.ok) {
    // Release the connection without reading (or logging) the error body.
    await response.body?.cancel().catch(() => {});
    fail('token_endpoint', { status: response.status });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    fail('token_endpoint', { status: response.status, ...errorDiagnostics(error) });
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const idToken = record?.id_token;
  if (typeof idToken !== 'string' || idToken.length === 0) fail('token_endpoint', { status: response.status });
  return { idToken };
}

/** The lowercased `hd`, or null unless it is exactly a valid domain (no trimming, no wildcard). */
function hostedDomain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const lowered = value.toLowerCase();
  const parsed = hostedDomainSchema.safeParse(lowered);
  return parsed.success && parsed.data === lowered ? lowered : null;
}

/** Verify a portal Google id_token. See the module header for every rule. */
export async function verifyPortalGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; now?: Date },
  deps: { verificationKey?: CryptoKey } = {},
): Promise<PortalGoogleVerifiedIdentity & { emailClaim: string }> {
  if (!expected.clientId) fail('client_id');

  // `aud` and `iss` are checked below, stricter than jose's options would.
  const options: JWTVerifyOptions = {
    algorithms: ['RS256'],
    requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce', 'email', 'email_verified', 'hd'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    maxTokenAge: ID_TOKEN_MAX_AGE_SECONDS,
    ...(expected.now ? { currentDate: expected.now } : {}),
  };

  let payload: JWTPayload & Record<string, unknown>;
  try {
    const verified = deps.verificationKey
      ? await jwtVerify(idToken, deps.verificationKey, options)
      : await jwtVerify(idToken, getGoogleJwks(), options);
    payload = verified.payload as JWTPayload & Record<string, unknown>;
  } catch (error) {
    // A jose ERR_* code is a token verdict; anything else is the JWKS fetch.
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ERR_')) fail('id_token_jwt', errorDiagnostics(error));
    fail('jwks_unavailable', errorDiagnostics(error));
  }

  // jose already refuses non-numeric dates and an iat beyond the tolerance in
  // the future (restated here so D1 does not rest on a library option alone).
  // Its maxTokenAge bound, though, is widened by clockTolerance (to 660 s), so
  // D1's "no older than 10 min" is enforced here, exactly.
  const nowSeconds = Math.floor((expected.now ?? new Date()).getTime() / 1000);
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') fail('timestamps');
  if (payload.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS) fail('iat');
  if (nowSeconds - payload.iat > ID_TOKEN_MAX_AGE_SECONDS) fail('iat');

  if (typeof payload.aud !== 'string' || payload.aud !== expected.clientId) fail('audience');
  if (payload.azp !== undefined && payload.azp !== expected.clientId) fail('azp');
  if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.has(payload.iss)) fail('issuer');
  if (!nonceMatches(payload.nonce, expected.nonce)) fail('nonce');
  if (typeof payload.sub !== 'string' || !GOOGLE_SUBJECT.test(payload.sub)) fail('sub');
  // Strict boolean: a string "true" does not verify.
  if (payload.email_verified !== true) fail('email_verified');
  const emailClaim = addressClaim(payload.email);
  if (!emailClaim) fail('email');
  const hd = hostedDomain(payload.hd);
  if (!hd) fail('hd');

  return {
    provider: 'google',
    issuer: PORTAL_GOOGLE_ISSUER,
    subject: payload.sub,
    entraTenantId: null,
    upn: null,
    emailClaim,
    emailDomainOwnerVerified: true,
    name: typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null,
    googleHostedDomain: hd,
  };
}
