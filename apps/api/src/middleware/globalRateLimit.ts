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
 *
 * When Redis is unavailable, falls back to a simple in-memory counter map
 * so requests are still metered (albeit per-process only).
 */

const SKIP_PATHS = new Set(['/health', '/ready']);

// Agent routes have their own per-agent rate limiter (agentAuthMiddleware),
// so exclude them from the global per-IP limit.  Without this, agent heartbeats
// and telemetry consume the same IP bucket as the dashboard UI — especially
// problematic in development where everything originates from localhost.
const SKIP_PREFIXES = ['/api/v1/agents/', '/api/v1/helper/'];
const MAX_IN_MEMORY_ENTRIES = 100_000;

// ---------------------------------------------------------------------------
// In-memory fallback rate limiter (used when Redis is unavailable)
// ---------------------------------------------------------------------------
const inMemoryCounters = new Map<string, { count: number; resetAt: number }>();
let lastCleanup = Date.now();
let inMemoryFallbackLogged = false;
const CLEANUP_INTERVAL_MS = 60_000; // prune expired entries every 60s

function cleanupExpiredEntries(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of inMemoryCounters) {
    if (entry.resetAt <= now) {
      inMemoryCounters.delete(key);
    }
  }
}

interface GlobalRateLimitOptions {
  /** Max requests per window. Default: 300 */
  limit?: number;
  /** Window size in seconds. Default: 60 */
  windowSeconds?: number;
}

export function globalRateLimit(options?: GlobalRateLimitOptions): MiddlewareHandler {
  const limit = options?.limit ?? 300;
  const windowSeconds = options?.windowSeconds ?? 60;
  const windowMs = windowSeconds * 1000;
  const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';

  return async (c: Context, next: Next) => {
    // In E2E testing mode, skip all rate limiting to avoid test flakiness
    if (e2eMode) {
      return next();
    }

    // Skip health checks — used by load balancers / k8s probes
    if (SKIP_PATHS.has(c.req.path)) {
      return next();
    }

    // Skip agent routes — they have dedicated per-agent rate limiting
    if (SKIP_PREFIXES.some(prefix => c.req.path.startsWith(prefix))) {
      return next();
    }

    const redis = getRedis();
    const clientIp = getTrustedClientIp(c, 'unknown');

    if (!redis) {
      // Redis unavailable — use in-memory fallback so requests are still metered.
      if (!inMemoryFallbackLogged) {
        console.warn('[RateLimit] Redis unavailable, using in-memory fallback');
        inMemoryFallbackLogged = true;
      }
      cleanupExpiredEntries();

      const now = Date.now();
      const entry = inMemoryCounters.get(clientIp);

      if (entry && entry.resetAt > now) {
        if (entry.count >= limit) {
          c.header('X-RateLimit-Limit', String(limit));
          c.header('X-RateLimit-Remaining', '0');
          c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
          c.header('Retry-After', String(windowSeconds));
          return c.json({ error: 'Too many requests' }, 429);
        }
        entry.count++;
      } else {
        if (inMemoryCounters.size >= MAX_IN_MEMORY_ENTRIES) {
          // Map full — reject to prevent OOM
          return c.json({ error: 'Too many requests' }, 429);
        }
        inMemoryCounters.set(clientIp, { count: 1, resetAt: now + windowMs });
      }

      return next();
    }

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
