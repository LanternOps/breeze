/**
 * The customer portal's Entra client (portal registration W4): authorize
 * URL, admin-consent URL, code exchange and id_token verification for
 * "Sign in with Microsoft" and the tenant-proof run.
 *
 * id_token rules (spec §5.7, inv. 13; plan Global Constraints), all enforced
 * by verifyPortalEntraIdToken:
 *   - signature against Microsoft's COMMON v2 JWKS (multi-tenant app: keys are
 *     shared across tenants, the issuer is not), RS256 only, `aud` = the
 *     portal app's client id;
 *   - required `iss aud exp iat tid oid nonce`; clock tolerance 60 s; `iat`
 *     no older than 10 min;
 *   - `iss === entraIssuer(tid)` (closes a token of tenant A posing as B),
 *     `ver === '2.0'`, `tid`/`oid` GUIDs, `tid` not the consumer (MSA) tenant,
 *     `nonce` equal in constant time;
 *   - guests, on USER SIGN-IN: STRUCTURALLY refused because user sign-in
 *     always uses the `organizations` authority, so Microsoft issues the token
 *     in the user's HOME tenant. Defence in depth: refuse an `idp` that is
 *     neither `iss` nor the tenant's own v1 STS issuer, and `acct === 1`. Both
 *     claims are optional; a token without them is accepted (the structural
 *     rule is the guarantee);
 *   - guests, on a TENANT-PROOF RUN: admitted when the caller passes
 *     `allowGuest` (plan Global Constraints "Proof run"). The run pins the
 *     tenant authority (D6), so a B2B guest's token is issued in the customer
 *     tenant, and a guest holding Global Administrator there is an admin of it;
 *     the Graph role check binds to `tid`/`oid`. `allowGuest` skips ONLY the
 *     two guest checks, and only with a pinned tenant: without one the token
 *     is refused (fail closed);
 *   - a pinned `expectedTenantId` (proof run, D6) must equal `tid`.
 * The subject is `oid`, never `sub`, so it equals the add-in's identity for
 * the same person.
 *
 * Failures throw PortalEntraTokenError(check). `check` names the failed step
 * for the server log only; nothing here logs or throws token, code, secret or
 * token-endpoint body content (D14, the `logIdentityCheckFailure` pattern of
 * services/ticketMailbox/microsoftIdentity.ts).
 */
import { createHash, timingSafeEqual } from 'crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';
import { PORTAL_ENTRA_CALLBACK_PATH, type PortalEntraConfig } from '../../config/portalEntra';
import { buildMicrosoftIdentityAuthorizationUrl } from '../m365ControlPlane/microsoftAuthorization';
import { entraIssuer } from '../portalUserIdentities';
import type { PortalOidcVerifiedIdentity } from './types';

export const PORTAL_ENTRA_SIGN_IN_SCOPE = 'openid profile email';
/** OD2: the proof run's live Graph admin-role check needs a directory read. */
export const PORTAL_ENTRA_PROOF_SCOPE = 'openid profile Directory.Read.All';

const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const MICROSOFT_JWKS_URL = `${MICROSOFT_LOGIN_ORIGIN}/common/discovery/v2.0/keys`;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Microsoft's consumer (MSA) tenant. */
const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';
const ID_TOKEN_MAX_AGE_SECONDS = 10 * 60;
const CLOCK_TOLERANCE_SECONDS = 60;
const TOKEN_ENDPOINT_TIMEOUT_MS = 15_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `check` is server-side diagnostics only; never token content. */
export class PortalEntraTokenError extends Error {
  override readonly name = 'PortalEntraTokenError';
  constructor(readonly check: string) {
    super('Microsoft sign-in verification failed');
  }
}

/** The underlying error's name and code only: never its message, which can carry a URL, token or body. */
function errorDiagnostics(error: unknown): { errorName: string; errorCode?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return { errorName: name, ...(typeof code === 'string' ? { errorCode: code } : {}) };
}

function fail(check: string, extra: { status?: number; errorName?: string; errorCode?: string } = {}): never {
  console.warn('[portal] Microsoft sign-in check failed', { check, ...extra });
  throw new PortalEntraTokenError(check);
}

function normalizeGuid(value: unknown): string | null {
  return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : null;
}

/** `organizations` or a tenant GUID; never `common`, `consumers` or a domain. */
function normalizeAuthority(value: string): string | null {
  return value === 'organizations' ? value : normalizeGuid(value);
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getMicrosoftJwks(): ReturnType<typeof createRemoteJWKSet> {
  cachedJwks ??= createRemoteJWKSet(new URL(MICROSOFT_JWKS_URL), {
    cacheMaxAge: 10 * 60 * 1000, // jose refreshes early on an unknown `kid`
    cooldownDuration: 30 * 1000,
  });
  return cachedJwks;
}

/** Wraps buildMicrosoftIdentityAuthorizationUrl: PKCE S256, `response_mode=query`, `prompt=select_account`. */
export function buildPortalEntraAuthorizeUrl(
  cfg: PortalEntraConfig,
  input: { authority: string; scope: string; state: string; nonce: string; codeChallenge: string },
): string {
  return buildMicrosoftIdentityAuthorizationUrl({
    authority: input.authority,
    clientId: cfg.clientId,
    redirectUri: cfg.callbackUrl,
    expectedCallbackPath: PORTAL_ENTRA_CALLBACK_PATH,
    state: input.state,
    nonce: input.nonce,
    codeChallenge: input.codeChallenge,
    scope: input.scope,
  });
}

/**
 * The v2 tenant-wide admin consent for the portal app (D6): sign-in scopes
 * only. Microsoft enforces consent itself; the consent-return route reads
 * nothing back as authority, so no `state` is sent.
 */
export function buildPortalAppAdminConsentUrl(cfg: PortalEntraConfig, tenantId: string): string {
  const tid = normalizeGuid(tenantId);
  if (!tid) throw new Error('portal_entra_invalid_tenant');
  const url = new URL(`${MICROSOFT_LOGIN_ORIGIN}/${tid}/v2.0/adminconsent`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('scope', PORTAL_ENTRA_SIGN_IN_SCOPE);
  url.searchParams.set('redirect_uri', cfg.consentReturnUrl);
  return url.toString();
}

/**
 * Redeem an authorization code at `/{authority}/oauth2/v2.0/token` with the
 * client secret and the PKCE verifier. Any failure — request error, non-2xx,
 * malformed body, no id_token — throws PortalEntraTokenError('token_endpoint')
 * after logging the status only. `accessToken` is optional (the proof run's
 * Graph role check uses it; sign-in does not).
 */
export async function exchangePortalEntraCode(
  cfg: PortalEntraConfig,
  input: { authority: string; code: string; codeVerifier: string },
  deps: { fetch?: typeof fetch } = {},
): Promise<{ idToken: string; accessToken: string | null }> {
  const authority = normalizeAuthority(input.authority);
  if (!authority) fail('authority');

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
    response = await fetchImpl(`${MICROSOFT_LOGIN_ORIGIN}/${authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_ENDPOINT_TIMEOUT_MS),
    });
  } catch (error) {
    fail('token_endpoint', errorDiagnostics(error));
  }
  if (!response.ok) fail('token_endpoint', { status: response.status });

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
  const accessToken = typeof record?.access_token === 'string' && record.access_token.length > 0 ? record.access_token : null;
  return { idToken, accessToken };
}

function nonceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length === 0 || expected.length === 0) return false;
  // Fixed-length digests: constant time regardless of either input's length.
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

function addressClaim(value: unknown): string | null {
  return typeof value === 'string' && value.includes('@') ? value.toLowerCase() : null;
}

/**
 * Verify a portal-app id_token. See the module header for every rule.
 * `allowGuest` is for the tenant-proof run only and requires a pinned
 * `expectedTenantId`; user sign-in, invite and link never pass it.
 */
export async function verifyPortalEntraIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; expectedTenantId: string | null; allowGuest?: boolean; now?: Date },
  deps: { verificationKey?: CryptoKey } = {},
): Promise<PortalOidcVerifiedIdentity & { entraTenantId: string }> {
  // A guest is admitted only into a pinned tenant: refuse the misuse before reading the token.
  const allowGuest = expected.allowGuest === true;
  if (allowGuest && (expected.expectedTenantId === null || normalizeGuid(expected.expectedTenantId) === null)) {
    fail('guest_unpinned');
  }

  const options: JWTVerifyOptions = {
    audience: expected.clientId,
    algorithms: ['RS256'],
    requiredClaims: ['iss', 'aud', 'exp', 'iat', 'tid', 'oid', 'nonce'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    maxTokenAge: ID_TOKEN_MAX_AGE_SECONDS,
    ...(expected.now ? { currentDate: expected.now } : {}),
  };

  let payload: JWTPayload & Record<string, unknown>;
  try {
    const verified = deps.verificationKey
      ? await jwtVerify(idToken, deps.verificationKey, options)
      : await jwtVerify(idToken, getMicrosoftJwks(), options);
    payload = verified.payload as JWTPayload & Record<string, unknown>;
  } catch (error) {
    // A jose ERR_* code is a token verdict; anything else is the JWKS fetch.
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ERR_')) fail('id_token_jwt', errorDiagnostics(error));
    fail('jwks_unavailable', errorDiagnostics(error));
  }

  const tid = normalizeGuid(payload.tid);
  if (!tid) fail('tid');
  if (tid === CONSUMER_TENANT_ID) fail('consumer_tenant');
  const issuer = entraIssuer(tid);
  if (payload.iss !== issuer) fail('issuer');
  if (payload.ver !== '2.0') fail('ver');
  if (!nonceMatches(payload.nonce, expected.nonce)) fail('nonce');
  const oid = normalizeGuid(payload.oid);
  if (!oid) fail('oid');

  // Guest refusal, defence in depth (the structural rule is the guarantee).
  // Skipped only for a proof run into a pinned tenant (enforced above).
  if (!allowGuest) {
    if (payload.idp !== undefined && payload.idp !== issuer && payload.idp !== `https://sts.windows.net/${tid}/`) {
      fail('guest_idp');
    }
    if (payload.acct === 1 || payload.acct === '1') fail('guest_acct');
  }

  if (expected.expectedTenantId !== null && normalizeGuid(expected.expectedTenantId) !== tid) {
    fail('tenant_mismatch');
  }

  return {
    provider: 'entra',
    issuer,
    subject: oid,
    entraTenantId: tid,
    upn: addressClaim(payload.preferred_username),
    emailClaim: addressClaim(payload.email),
    // Strict boolean: a string "true" does not verify.
    emailDomainOwnerVerified: payload.xms_edov === true,
    name: typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null,
  };
}
