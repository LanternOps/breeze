import { getRedis } from './redis';

const ACCESS_TOKEN_REVOCATION_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_REVOCATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const USER_REVOCATION_TTL_SECONDS = REFRESH_TOKEN_REVOCATION_TTL_SECONDS + ACCESS_TOKEN_REVOCATION_TTL_SECONDS;

function getRevokedAccessKey(userId: string): string {
  return `token:revoked:${userId}`;
}

function getRevokedAfterKey(userId: string): string {
  return `token:revoked_after:${userId}`;
}

function getRevokedRefreshKey(jti: string): string {
  return `token:refresh:revoked:${jti}`;
}

export async function isUserTokenRevoked(userId: string, tokenIssuedAt?: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[token-revocation] Redis unavailable — failing closed (treating token as revoked)');
    return true;
  }

  try {
    const revoked = await redis.get(getRevokedAccessKey(userId));
    if (revoked) {
      return true;
    }

    if (typeof tokenIssuedAt !== 'number' || !Number.isFinite(tokenIssuedAt)) {
      return false;
    }

    const revokedAfterRaw = await redis.get(getRevokedAfterKey(userId));
    if (!revokedAfterRaw) {
      return false;
    }

    const revokedAfter = Number.parseInt(revokedAfterRaw, 10);
    if (!Number.isFinite(revokedAfter)) {
      return false;
    }

    return tokenIssuedAt <= revokedAfter;
  } catch (error) {
    console.error('[token-revocation] Failed to check token revocation state — failing closed:', error);
    return true;
  }
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[token-revocation] Redis unavailable — cannot revoke user tokens');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    await redis
      .multi()
      .setex(getRevokedAccessKey(userId), ACCESS_TOKEN_REVOCATION_TTL_SECONDS, '1')
      .setex(getRevokedAfterKey(userId), USER_REVOCATION_TTL_SECONDS, String(nowSeconds))
      .exec();
  } catch (error) {
    console.error('[token-revocation] Failed to revoke user tokens:', error);
    throw error;
  }
}

export async function isRefreshTokenJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[token-revocation] Redis unavailable — failing closed (treating refresh token as revoked)');
    return true;
  }

  try {
    const revoked = await redis.get(getRevokedRefreshKey(jti));
    return Boolean(revoked);
  } catch (error) {
    console.error('[token-revocation] Failed to check refresh token revocation — failing closed:', error);
    return true;
  }
}

export async function revokeRefreshTokenJti(jti: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[token-revocation] Redis unavailable — cannot revoke refresh token');
  }

  try {
    await redis.setex(getRevokedRefreshKey(jti), REFRESH_TOKEN_REVOCATION_TTL_SECONDS, '1');
  } catch (error) {
    console.error('[token-revocation] Failed to revoke refresh token:', error);
    throw error;
  }
}
