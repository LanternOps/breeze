import { SignJWT, jwtVerify, type JWTHeaderParameters } from 'jose';
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
const VIEWER_ACCESS_TOKEN_EXPIRY = e2eMode ? '24h' : '2h';

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
 */
function getSignKey(): { key: Uint8Array; kid?: string } {
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
function getVerifyKey(header: JWTHeaderParameters): Uint8Array {
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
  // Indicates whether this token was issued after completing MFA.
  // For legacy tokens that predate this claim, verification defaults this to false.
  mfa: boolean;
  // Mobile device binding (SR-001). Set only on tokens minted for the mobile
  // app, to the per-install device id. Absent on web/MCP/OAuth/agent tokens.
  // The lost-phone block is enforced against this SIGNED value, never a
  // client-supplied header (which is spoofable / omittable).
  mdid?: string;
  iat?: number;
  jti?: string;
}

export interface ViewerTokenPayload {
  sub: string;
  email: string;
  sessionId: string;
  purpose: 'viewer';
  jti: string;
  iat?: number;
}

function buildHeader(kid?: string): { alg: 'HS256'; kid?: string } {
  return kid ? { alg: 'HS256', kid } : { alg: 'HS256' };
}

export async function createAccessToken(payload: Omit<TokenPayload, 'type'>): Promise<string> {
  const { key, kid } = getSignKey();

  return new SignJWT({ ...payload, type: 'access' })
    .setProtectedHeader(buildHeader(kid))
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-api')
    .sign(key);
}

export async function createRefreshToken(payload: Omit<TokenPayload, 'type'>): Promise<string> {
  const { key, kid } = getSignKey();

  return new SignJWT({ ...payload, type: 'refresh' })
    .setProtectedHeader(buildHeader(kid))
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-api')
    .sign(key);
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, {
      issuer: 'breeze',
      audience: 'breeze-api',
      algorithms: ['HS256']
    });

    return {
      sub: payload.sub as string,
      email: payload.email as string,
      roleId: payload.roleId as string | null,
      orgId: payload.orgId as string | null,
      partnerId: payload.partnerId as string | null,
      scope: payload.scope as 'system' | 'partner' | 'organization',
      type: payload.type as 'access' | 'refresh',
      mfa: payload.mfa === true,
      mdid: typeof payload.mdid === 'string' && payload.mdid.length > 0 ? payload.mdid : undefined,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined
    };
  } catch (error) {
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

export async function createTokenPair(
  payload: Omit<TokenPayload, 'type'>
): Promise<{ accessToken: string; refreshToken: string; expiresInSeconds: number }> {
  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(payload),
    createRefreshToken(payload)
  ]);

  return {
    accessToken,
    refreshToken,
    expiresInSeconds: e2eMode ? 24 * 60 * 60 : 15 * 60
  };
}
