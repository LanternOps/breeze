import { getRedis } from './redis';

const REVOKE_TTL_SECONDS = 8 * 60 * 60; // Match max viewer TTL so keys auto-expire.

export async function revokeViewerJti(jti: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return; // Best-effort on the revoke side — check-side fails closed.
  await redis.set(`viewer-jti-revoked:${jti}`, '1', 'EX', REVOKE_TTL_SECONDS);
}

export async function isViewerJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — failing closed');
    return true;
  }
  return (await redis.get(`viewer-jti-revoked:${jti}`)) === '1';
}
