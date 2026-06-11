import { getRedis } from '../services/redis';
import { ERROR_IDS, logOauthError } from './log';

const KEY = (jti: string) => `oauth:revoked:${jti}`;
const GRANT_KEY = (grantId: string) => `oauth:revoked:grant:${grantId}`;

function isOAuthEnabled(): boolean {
  const raw = process.env.MCP_OAUTH_ENABLED;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function missingRedisError(): Error {
  return new Error('OAuth revocation cache unavailable: Redis is required when MCP_OAUTH_ENABLED is true');
}

export async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    if (isOAuthEnabled()) {
      throw missingRedisError();
    }
    return;
  }
  await redis.set(KEY(jti), '1', 'EX', Math.max(ttlSeconds, 1));
}

export async function isJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    if (isOAuthEnabled()) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_READ_FAILED,
        message: 'jti revocation cache read failed; Redis missing while OAuth enabled — failing closed',
        context: { jti },
      });
      return true;
    }
    return false;
  }
  try {
    const v = await redis.get(KEY(jti));
    return v === '1';
  } catch (err) {
    // Fail closed when OAuth is enabled: a Redis hiccup mid-call must not
    // let a potentially revoked token through. When OAuth is disabled the
    // cache is a no-op and we report "not revoked" as before.
    logOauthError({
      errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_READ_FAILED,
      message: 'jti revocation cache read failed',
      err,
      context: { jti, oauthEnabled: isOAuthEnabled() },
    });
    return isOAuthEnabled();
  }
}

/**
 * Mark an entire OAuth Grant as revoked. Used when:
 *   - A refresh token is revoked (`/oauth/token/revocation`) — every access
 *     token derived from the same Grant should die immediately rather than
 *     surviving until natural 10-minute expiry.
 *   - A connected app is deleted from the dashboard
 *     (`DELETE /api/v1/oauth/clients/:id`) — same goal, every active session
 *     for that user+client tuple must end.
 *   - The provider's adapter calls `revokeByGrantId(grantId)` (replay
 *     detection on a rotated refresh token).
 *
 * TTL should be at least the configured AccessToken lifetime so the marker
 * outlives the longest-lived JWT minted under this grant. Bearer middleware
 * checks this in addition to the per-jti cache; either match → 401.
 */
export async function revokeGrant(grantId: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    if (isOAuthEnabled()) {
      throw missingRedisError();
    }
    return;
  }
  await redis.set(GRANT_KEY(grantId), '1', 'EX', Math.max(ttlSeconds, 1));
}

export async function isGrantRevoked(grantId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    if (isOAuthEnabled()) {
      logOauthError({
        errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_READ_FAILED,
        message: 'grant revocation cache read failed; Redis missing while OAuth enabled — failing closed',
        context: { grantId },
      });
      return true;
    }
    return false;
  }
  try {
    const v = await redis.get(GRANT_KEY(grantId));
    return v === '1';
  } catch (err) {
    // Same fail-closed posture as isJtiRevoked when OAuth is enabled.
    logOauthError({
      errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_READ_FAILED,
      message: 'grant revocation cache read failed',
      err,
      context: { grantId, oauthEnabled: isOAuthEnabled() },
    });
    return isOAuthEnabled();
  }
}
