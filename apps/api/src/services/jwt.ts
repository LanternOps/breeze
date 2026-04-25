import { SignJWT, jwtVerify } from 'jose';
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

function getSecretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
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

export async function createAccessToken(payload: Omit<TokenPayload, 'type'>): Promise<string> {
  const secret = getSecretKey();

  return new SignJWT({ ...payload, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-api')
    .sign(secret);
}

export async function createRefreshToken(payload: Omit<TokenPayload, 'type'>): Promise<string> {
  const secret = getSecretKey();

  return new SignJWT({ ...payload, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-api')
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jwtVerify(token, secret, {
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
  const secret = getSecretKey();

  return new SignJWT({ ...payload, purpose: 'viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(VIEWER_ACCESS_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-viewer')
    .sign(secret);
}

export async function verifyViewerAccessToken(token: string): Promise<ViewerTokenPayload | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jwtVerify(token, secret, {
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
