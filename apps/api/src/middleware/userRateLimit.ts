import type { MiddlewareHandler } from 'hono';
import type { AuthContext } from './auth';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';

/**
 * Per-user sliding-window rate limit. Must run AFTER authMiddleware.
 * Keyed on the authenticated user id so one user cannot consume another's
 * budget. Fails closed (401) if no auth context is present.
 */
export function userRateLimit(bucket: string, limit: number, windowSeconds: number): MiddlewareHandler {
  return async (c, next) => {
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
    await next();
  };
}
