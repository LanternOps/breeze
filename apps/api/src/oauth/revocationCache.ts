import { getRedis } from '../services/redis';

const KEY = (jti: string) => `oauth:revoked:${jti}`;
const GRANT_KEY = (grantId: string) => `oauth:revoked:grant:${grantId}`;

export async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  // Lossy write is acceptable: DB refresh-token revocation still bounds reuse.
  if (!redis) return;
  await redis.set(KEY(jti), '1', 'EX', Math.max(ttlSeconds, 1));
}

export async function isJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    const v = await redis.get(KEY(jti));
    return v === '1';
  } catch (err) {
    // Fail closed: a Redis hiccup mid-call must not let a potentially
    // revoked token through. The bearer middleware will reject.
    console.error('[oauth] revocation cache read failed; failing closed', err);
    return true;
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
  if (!redis) return;
  await redis.set(GRANT_KEY(grantId), '1', 'EX', Math.max(ttlSeconds, 1));
}

export async function isGrantRevoked(grantId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    const v = await redis.get(GRANT_KEY(grantId));
    return v === '1';
  } catch (err) {
    // Same fail-closed posture as isJtiRevoked: a Redis blip during a
    // revocation check must not let a potentially-revoked grant through.
    console.error('[oauth] grant revocation cache read failed; failing closed', err);
    return true;
  }
}
