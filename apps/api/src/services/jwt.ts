import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'crypto';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

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
  iat?: number;
  jti?: string;
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
      audience: 'breeze-api'
    });

    return {
      sub: payload.sub as string,
      email: payload.email as string,
      roleId: payload.roleId as string | null,
      orgId: payload.orgId as string | null,
      partnerId: payload.partnerId as string | null,
      scope: payload.scope as 'system' | 'partner' | 'organization',
      type: payload.type as 'access' | 'refresh',
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined
    };
  } catch {
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
    expiresInSeconds: 15 * 60 // 15 minutes
  };
}
