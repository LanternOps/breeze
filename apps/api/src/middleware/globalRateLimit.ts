import type { Context, MiddlewareHandler, Next } from 'hono';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp } from '../services/clientIp';

/**
 * Global per-IP rate limiter middleware.
 *
 * Applies a blanket request cap per client IP across all API routes.
 * Individual routes can still have their own stricter limits (login, register, etc.).
 *
 * Skips health/readiness probes so load balancers and monitoring aren't affected.
 */

const SKIP_PATHS = new Set(['/health', '/ready']);

interface GlobalRateLimitOptions {
  /** Max requests per window. Default: 300 */
  limit?: number;
  /** Window size in seconds. Default: 60 */
  windowSeconds?: number;
}

export function globalRateLimit(options?: GlobalRateLimitOptions): MiddlewareHandler {
  const limit = options?.limit ?? 300;
  const windowSeconds = options?.windowSeconds ?? 60;

  return async (c: Context, next: Next) => {
    // Skip health checks — used by load balancers / k8s probes
    if (SKIP_PATHS.has(c.req.path)) {
      return next();
    }

    const redis = getRedis();
    if (!redis) {
      // If Redis is down, let requests through rather than blocking the whole API.
      // Per-route rate limits (which fail closed) still protect sensitive endpoints.
      return next();
    }

    const clientIp = getTrustedClientIp(c, 'unknown');
    const key = `global:${clientIp}`;

    const result = await rateLimiter(redis, key, limit, windowSeconds);

    // Always set rate limit headers so clients can self-throttle
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));

    if (!result.allowed) {
      c.header('Retry-After', String(windowSeconds));
      return c.json({ error: 'Too many requests' }, 429);
    }

    return next();
  };
}
