import type { AuthContext } from './auth';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { preContextCheck } from './preContextChecks';

/**
 * Per-user sliding-window rate limit. Must run AFTER authMiddleware.
 * Keyed on the authenticated user id so one user cannot consume another's
 * budget. Fails closed (401) if no auth context is present.
 *
 * authMiddleware evaluates this BEFORE it opens the request's DB transaction
 * (see preContextChecks.ts), so the Redis round-trip never pins a pooled
 * connection idle-in-transaction (#8334 / #1105).
 */
export function userRateLimit(bucket: string, limit: number, windowSeconds: number) {
  return preContextCheck(async (c) => {
    const auth = c.get('auth') as AuthContext | undefined;
    const userId = auth?.user?.id;
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    const redis = getRedis();
    const result = await rateLimiter(redis, `rl:${bucket}:${userId}`, limit, windowSeconds);
    if (!result.allowed) {
      return c.json(
        { error: 'Rate limit exceeded', retryAfter: result.resetAt.toISOString() },
        429,
      );
    }
    return null;
  });
}
