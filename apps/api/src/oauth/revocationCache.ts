import { getRedis } from '../services';

const KEY = (jti: string) => `oauth:revoked:${jti}`;

export async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  // Lossy write is acceptable: DB refresh-token revocation still bounds reuse.
  if (!redis) return;
  await redis.set(KEY(jti), '1', 'EX', Math.max(ttlSeconds, 1));
}

export async function isJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const v = await redis.get(KEY(jti));
  return v === '1';
}
