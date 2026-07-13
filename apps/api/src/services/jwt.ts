import { SignJWT, jwtVerify, errors as joseErrors, type JWTHeaderParameters } from 'jose';
import { randomUUID } from 'crypto';

const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';
const ACCESS_TOKEN_EXPIRY = e2eMode ? '24h' : '15m';
const REFRESH_TOKEN_EXPIRY = e2eMode ? '30d' : '7d';
// Viewer sessions (WebRTC + VNC) routinely outlast 15m — the viewer polls
// /api/v1/devices/:id every 5s to detect user-session transitions for the
// login-window → logged-in auto-handoff, and remote-desktop sessions often
// run for hours. A 15m access token turned into silent 401s that killed the
// poll and the auto-handoff with it. The token is scoped to purpose='viewer'
// and a specific sessionId. TTL reduced to 2h (from 8h) and jti revocation
// is enforced on tunnel close, so the window of exposure is now bounded.
const VIEWER_ACCESS_TOKEN_EXPIRY_HOURS = e2eMode ? 24 : 2;
const VIEWER_ACCESS_TOKEN_EXPIRY = `${VIEWER_ACCESS_TOKEN_EXPIRY_HOURS}h`;
// Numeric seconds form of the *real* signed viewer-token TTL, exported so the
// /connect/exchange (and VNC exchange) responses advertise the true lifetime
// instead of a stale 15-minute value. Security finding #6: the advertised
// `expiresInSeconds` (was 900) understated the actual 2h TTL by 8x. Derived
// from the same hours constant as the JWT itself so the two can never drift.
//
// NOTE: finding #6 concerns the VIEWER-TOKEN exchange responses only. The
// regular login access token (ACCESS_TOKEN_EXPIRY, below) is legitimately 15m
// and `createTokenPair`'s advertised `expiresInSeconds` of 900 is correct for
// it — don't "fix" that value to match this constant.
export const VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS = VIEWER_ACCESS_TOKEN_EXPIRY_HOURS * 60 * 60;

// ---------------------------------------------------------------------------
// Signing keyring (zero-downtime rotation via `kid` header)
// ---------------------------------------------------------------------------
//
// Two modes, switched by presence of JWT_SIGNING_KEYRING:
//
// 1) Keyring set: `JWT_SIGNING_KEYRING` is a JSON map of `kid -> secret`
//    (each secret ≥32 chars). `JWT_ACTIVE_KID` selects the kid that signs
//    *new* tokens. Every other kid in the keyring is verify-only — that's
//    how a rotation drains: flip the active kid, leave the old one in for
//    one access-token lifetime, then remove it.
//
//    `JWT_SECRET` is kept as a verify-only fallback for tokens minted before
//    the keyring deploy (those carry no `kid` header).
//
// 2) Keyring unset: legacy single-secret behavior. `JWT_SECRET` signs and
//    verifies. No `kid` header is emitted.
//
// The keyring is cached on first parse and invalidated when the underlying
// env var string changes — mirroring the pattern in services/secretCrypto.ts.

let cachedKeyringRaw: string | undefined;
let cachedKeyring: Map<string, Uint8Array> | null = null;

function getKeyringEnv(): string | undefined {
  return process.env.JWT_SIGNING_KEYRING;
}

function getSigningKeyring(): Map<string, Uint8Array> {
  const raw = getKeyringEnv();
  if (cachedKeyring && cachedKeyringRaw === raw) {
    return cachedKeyring;
  }

  const keyring = new Map<string, Uint8Array>();
  if (raw && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('JWT_SIGNING_KEYRING must be a JSON object of kid → secret');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JWT_SIGNING_KEYRING must be a JSON object of kid → secret');
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      throw new Error('JWT_SIGNING_KEYRING is empty');
    }

    const encoder = new TextEncoder();
    for (const [kid, secret] of entries) {
      const trimmedKid = kid.trim();
      if (!trimmedKid) {
        throw new Error('JWT_SIGNING_KEYRING contains an empty kid');
      }
      if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error(`JWT_SIGNING_KEYRING['${trimmedKid}'] must be a string ≥32 chars`);
      }
      keyring.set(trimmedKid, encoder.encode(secret));
    }
  }

  cachedKeyringRaw = raw;
  cachedKeyring = keyring;
  return keyring;
}

function getActiveSigningKid(): string | null {
  const keyring = getSigningKeyring();
  if (keyring.size === 0) {
    return null;
  }
  const activeKid = process.env.JWT_ACTIVE_KID;
  if (!activeKid) {
    throw new Error('JWT_ACTIVE_KID must be set when JWT_SIGNING_KEYRING is configured');
  }
  if (!keyring.has(activeKid)) {
    throw new Error(
      `JWT_ACTIVE_KID='${activeKid}' is not present in JWT_SIGNING_KEYRING`
    );
  }
  return activeKid;
}

function getLegacySecretKey(): Uint8Array | null {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    return null;
  }
  return new TextEncoder().encode(secret);
}

/**
 * Returns the key used to sign *new* tokens, and the `kid` that should be
 * emitted in the protected header (omitted in legacy single-secret mode).
 *
 * Exported so sibling token modules (e.g. quoteAcceptToken.ts) sign with the
 * same keyring instead of duplicating key material.
 */
export function getSignKey(): { key: Uint8Array; kid?: string } {
  const activeKid = getActiveSigningKid();
  if (activeKid) {
    const keyring = getSigningKeyring();
    const key = keyring.get(activeKid);
    if (!key) {
      // Should be unreachable — getActiveSigningKid already validated presence.
      throw new Error(`JWT_ACTIVE_KID='${activeKid}' is not present in JWT_SIGNING_KEYRING`);
    }
    return { key, kid: activeKid };
  }

  const legacy = getLegacySecretKey();
  if (!legacy) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return { key: legacy };
}

/**
 * jose-shaped verify-key resolver. Looks up `header.kid` in the keyring;
 * falls back to `JWT_SECRET` for legacy tokens that carry no `kid`.
 *
 * Tokens whose `kid` is set but absent from the keyring are rejected —
 * we deliberately do NOT fall back to JWT_SECRET in that case (an attacker
 * who minted a token with a forged kid mustn't get a free pass through the
 * legacy path).
 */
export function getVerifyKey(header: JWTHeaderParameters): Uint8Array {
  const kid = header.kid;
  if (typeof kid === 'string' && kid.length > 0) {
    const keyring = getSigningKeyring();
    const key = keyring.get(kid);
    if (!key) {
      throw new Error(`Unknown kid '${kid}' in JWT header`);
    }
    return key;
  }

  const legacy = getLegacySecretKey();
  if (legacy) {
    return legacy;
  }

  throw new Error(
    'No verification key available: token has no kid and JWT_SECRET is unset'
  );
}

export interface TokenPayload {
  sub: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  type: 'access' | 'refresh';
  // Durable user security epochs. Verification requires both claims so tokens
  // minted before the lifecycle-hardening rollout fail closed.
  ae: number;
  me: number;
  // Indicates whether this token was issued after completing MFA.
  // Kept for compatibility with existing requireMfa consumers, but accepted
  // only when it is consistent with the signed authentication-method record.
  mfa: boolean;
  amr: readonly AuthenticationMethod[];
  // Mobile device binding (SR-001). Set only on tokens minted for the mobile
  // app, to the per-install device id. Absent on web/MCP/OAuth/agent tokens.
  // The lost-phone block is enforced against this SIGNED value, never a
  // client-supplied header (which is spoofable / omittable).
  mdid?: string;
  // Access-token session id. It is the same durable refresh-token family id
  // carried in the paired refresh token's `fam` claim.
  sid?: string;
  // Refresh-token family id (RFC 9700 §4.13.2). Required on refresh tokens
  // and absent from access tokens. Each new session mints a fresh family;
  // every rotation inherits the family from the prior refresh token.
  fam?: string;
  iat?: number;
  jti?: string;
}

export const AUTHENTICATION_METHODS = [
  'password',
  'totp',
  'sms',
  'passkey',
  'recovery_code',
  'sso',
  'cf_access',
] as const;
export type AuthenticationMethod = typeof AUTHENTICATION_METHODS[number];

export const LOCAL_MFA_AUTHENTICATION_METHODS = [
  'totp',
  'sms',
  'passkey',
  'recovery_code',
] as const;
export type LocalMfaAuthenticationMethod = typeof LOCAL_MFA_AUTHENTICATION_METHODS[number];

const authenticationMethodSet = new Set<string>(AUTHENTICATION_METHODS);
const primaryAuthenticationMethodSet = new Set<string>(['password', 'sso', 'cf_access']);
const localMfaAuthenticationMethodSet = new Set<string>(LOCAL_MFA_AUTHENTICATION_METHODS);

/**
 * Parse the signed AMR claim and enforce the combinations Breeze can actually
 * issue. Every session has exactly one primary authenticator and at most one
 * local factor. A local factor is MFA, while an external primary may carry
 * mfa=true only when its issuer verified the integration-specific trust signal.
 */
export function parseAuthenticationMethods(
  value: unknown,
  mfa: unknown,
): AuthenticationMethod[] | null {
  if (typeof mfa !== 'boolean' || !Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (!value.every((method): method is AuthenticationMethod => (
    typeof method === 'string' && authenticationMethodSet.has(method)
  ))) {
    return null;
  }
  if (new Set(value).size !== value.length) return null;

  const primaryMethods = value.filter((method) => primaryAuthenticationMethodSet.has(method));
  const localMethods = value.filter((method) => localMfaAuthenticationMethodSet.has(method));
  if (primaryMethods.length !== 1 || localMethods.length > 1) return null;
  if (localMethods.length === 1 && mfa !== true) return null;
  if (primaryMethods[0] === 'password' && localMethods.length === 0 && mfa !== false) return null;

  return [...value];
}

export function getLocalMfaAuthenticationMethod(
  methods: readonly AuthenticationMethod[],
): LocalMfaAuthenticationMethod | null {
  return methods.find(
    (method): method is LocalMfaAuthenticationMethod => localMfaAuthenticationMethodSet.has(method),
  ) ?? null;
}

function assertAuthenticationMethodsForSigning(payload: TokenSigningPayload): void {
  if (!parseAuthenticationMethods(payload.amr, payload.mfa)) {
    throw new Error('Invalid authentication methods for first-party token');
  }
}

/**
 * Transitional input for low-level signers. First-party callers should use
 * `issueUserSession`, which supplies all mandatory claims from live DB state.
 * Keeping epochs optional here lets isolated non-session tests and the route
 * migration land in separate, reviewable commits; `verifyToken` remains strict.
 */
export type TokenSigningPayload = Omit<TokenPayload, 'type' | 'ae' | 'me'> & {
  ae?: number;
  me?: number;
};

export interface ViewerTokenPayload {
  sub: string;
  email: string;
  sessionId: string;
  purpose: 'viewer';
  jti: string;
  iat?: number;
}

export function buildHeader(kid?: string): { alg: 'HS256'; kid?: string } {
  return kid ? { alg: 'HS256', kid } : { alg: 'HS256' };
}

export async function createAccessToken(payload: TokenSigningPayload): Promise<string> {
  assertAuthenticationMethodsForSigning(payload);
  const { key, kid } = getSignKey();
  const { fam: _famIgnored, ...accessPayload } = payload;
  void _famIgnored;

  return new SignJWT({ ...accessPayload, type: 'access' })
    .setProtectedHeader(buildHeader(kid))
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-api')
    .sign(key);
}

export async function createRefreshToken(payload: TokenSigningPayload): Promise<string> {
  return (await createRefreshTokenWithJti(payload)).token;
}

/**
 * Like `createRefreshToken` but also returns the embedded jti so callers
 * can establish a jti → family mapping (Task 7) without re-verifying the
 * token. Used by `createTokenPair` for the family-aware path.
 */
export async function createRefreshTokenWithJti(
  payload: TokenSigningPayload,
  options: { jti?: string } = {},
): Promise<{ token: string; jti: string }> {
  assertAuthenticationMethodsForSigning(payload);
  const { key, kid } = getSignKey();
  const jti = options.jti ?? randomUUID();
  const { sid: _sidIgnored, ...refreshPayload } = payload;
  void _sidIgnored;

  const token = await new SignJWT({ ...refreshPayload, type: 'refresh' })
    .setProtectedHeader(buildHeader(kid))
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-api')
    .sign(key);

  return { token, jti };
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, {
      issuer: 'breeze',
      audience: 'breeze-api',
      algorithms: ['HS256']
    });

    const type = payload.type;
    const authEpoch = payload.ae;
    const mfaEpoch = payload.me;
    const amr = parseAuthenticationMethods(payload.amr, payload.mfa);
    const sid = typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : undefined;
    const fam = typeof payload.fam === 'string' && payload.fam.length > 0 ? payload.fam : undefined;
    if (
      (type !== 'access' && type !== 'refresh')
      || !Number.isSafeInteger(authEpoch)
      || (authEpoch as number) < 1
      || !Number.isSafeInteger(mfaEpoch)
      || (mfaEpoch as number) < 1
      || !amr
      || (type === 'access' && !sid)
      || (type === 'refresh' && !fam)
    ) {
      return null;
    }

    return {
      sub: payload.sub as string,
      email: payload.email as string,
      roleId: payload.roleId as string | null,
      orgId: payload.orgId as string | null,
      partnerId: payload.partnerId as string | null,
      scope: payload.scope as 'system' | 'partner' | 'organization',
      type,
      ae: authEpoch as number,
      me: mfaEpoch as number,
      mfa: payload.mfa as boolean,
      amr,
      mdid: typeof payload.mdid === 'string' && payload.mdid.length > 0 ? payload.mdid : undefined,
      sid,
      fam,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined
    };
  } catch (error) {
    // Routes that accept multiple bearer formats (JWT, API key, agent token,
    // enrollment token, …) call verifyToken first. A non-JWT input lands here
    // as JWSInvalid / JWTInvalid — expected, not a failure. Logging it sends
    // misleading "Token verification failed" noise to stderr right next to a
    // 200 from the fallback auth path.
    if (error instanceof joseErrors.JWSInvalid || error instanceof joseErrors.JWTInvalid) {
      return null;
    }
    console.debug('[jwt] Token verification failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function createViewerAccessToken(
  payload: Omit<ViewerTokenPayload, 'purpose' | 'jti'>
): Promise<string> {
  const { key, kid } = getSignKey();

  return new SignJWT({ ...payload, purpose: 'viewer' })
    .setProtectedHeader(buildHeader(kid))
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(VIEWER_ACCESS_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-viewer')
    .sign(key);
}

export async function verifyViewerAccessToken(token: string): Promise<ViewerTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, {
      issuer: 'breeze',
      audience: 'breeze-viewer',
      algorithms: ['HS256']
    });

    if (payload.purpose !== 'viewer') {
      return null;
    }
    // jti must be present and non-empty — revocation lookups would otherwise
    // match every empty-jti token against the same revoke key.
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
      return null;
    }

    return {
      sub: payload.sub as string,
      email: payload.email as string,
      sessionId: payload.sessionId as string,
      purpose: 'viewer',
      jti: payload.jti,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined
    };
  } catch (error) {
    console.debug('[jwt] Viewer token verification failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

export interface CreateTokenPairOptions {
  /**
   * Refresh-token family id. First-party session callers must supply it; the
   * optional shape remains only for low-level non-session test/caller
   * compatibility while `verifyToken` rejects refresh tokens without it.
   */
  refreshFam?: string;
  /** Pre-generated inside the authoritative family transaction. */
  refreshJti?: string;
}

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  refreshJti: string;
  expiresInSeconds: number;
};

export async function createTokenPair(
  payload: TokenSigningPayload,
  options: CreateTokenPairOptions = {}
): Promise<TokenPair> {
  // Strip `fam` from the access-token payload defensively — it should never
  // have been propagated there in the first place, but enforce here so any
  // future caller can't accidentally leak it.
  const { fam: _famIgnored, ...accessPayload } = payload;
  void _famIgnored;
  const refreshPayload: TokenSigningPayload = options.refreshFam
    ? { ...payload, fam: options.refreshFam }
    : payload;

  const [accessToken, refresh] = await Promise.all([
    createAccessToken(accessPayload),
    createRefreshTokenWithJti(refreshPayload, { jti: options.refreshJti })
  ]);

  return {
    accessToken,
    refreshToken: refresh.token,
    refreshJti: refresh.jti,
    expiresInSeconds: e2eMode ? 24 * 60 * 60 : 15 * 60
  };
}
