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
const BUILT_IN_SKIP_PREFIXES = ['/api/v1/agents/', '/api/v1/helper/'];
const skipPrefixes: string[] = [...BUILT_IN_SKIP_PREFIXES];
const MAX_IN_MEMORY_ENTRIES = 100_000;

/**
 * A path prefix metered in its own per-IP bucket rather than the shared one.
 *
 * Isolation — not exemption. Traffic matching the prefix is still capped, so a
 * runaway or hostile client can't hammer the endpoint unbounded; it simply
 * spends a budget nothing else draws on.
 */
export interface IsolatedBucket {
  /** Path prefix routed into this bucket. */
  prefix: string;
  /** Key namespace. Must be unique across buckets. */
  name: string;
  /** Max requests per window for this bucket (independent of the global cap). */
  limit: number;
}

/**
 * Remote-desktop viewer traffic gets its own bucket (issue #3041).
 *
 * While waiting for the agent's WebRTC answer the viewer polls
 * `/api/v1/desktop-ws/:id/viewer/session` repeatedly, so one connection attempt
 * is inherently dozens of requests — and when the session dies mid-poll every
 * one of them 401s. Sharing the default bucket let that burst exhaust the
 * per-IP budget and 429 the operator's *own* dashboard and auth calls, bouncing
 * them to the login screen while their session was still valid. A dedicated
 * bucket keeps the viewer path bounded without letting it starve the console.
 *
 * Sizing: with the viewer's backed-off poll a single connection attempt costs
 * ~35 requests (ice-servers + offer + ~34 answer polls across the 15s window),
 * so 600/min leaves room for roughly 16 attempts a minute from one IP — enough
 * for several techs behind one office NAT reconnecting, while still capping a
 * runaway client at ~10 req/s. Note the prefix covers ALL desktop-ws traffic,
 * so one runaway viewer can still throttle other remote sessions from the same
 * IP; it just can no longer touch the dashboard or auth budget.
 */
export const ISOLATED_BUCKETS: readonly IsolatedBucket[] = [
  { prefix: '/api/v1/desktop-ws/', name: 'desktopws', limit: 600 },
];

export function registerGlobalRateLimitSkipPrefix(prefix: string): void {
  if (!skipPrefixes.includes(prefix)) {
    skipPrefixes.push(prefix);
  }
}

export function __resetSkipPrefixesForTests(): void {
  skipPrefixes.splice(0, skipPrefixes.length, ...BUILT_IN_SKIP_PREFIXES);
}

/**
 * Clear the in-memory fallback counters so each test starts from a clean
 * budget. Only meaningful when Redis is stubbed out.
 */
export function __resetInMemoryCountersForTests(): void {
  inMemoryCounters.clear();
}

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
  /** Max requests per window for the shared bucket. Default: 300 */
  limit?: number;
  /** Window size in seconds. Default: 60 */
  windowSeconds?: number;
  /**
   * Paths metered separately from the shared bucket.
   * Defaults to {@link ISOLATED_BUCKETS}; overridable so tests can exercise the
   * capping behaviour without issuing hundreds of requests.
   */
  isolatedBuckets?: readonly IsolatedBucket[];
}

export function globalRateLimit(options?: GlobalRateLimitOptions): MiddlewareHandler {
  const limit = options?.limit ?? 300;
  const windowSeconds = options?.windowSeconds ?? 60;
  const isolatedBuckets = options?.isolatedBuckets ?? ISOLATED_BUCKETS;
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
    if (skipPrefixes.some(prefix => c.req.path.startsWith(prefix))) {
      return next();
    }

    const redis = getRedis();
    const clientIp = getTrustedClientIp(c, 'unknown');

    // Route into a dedicated bucket when the path has one, so high-volume
    // endpoints can't drain the budget shared by the dashboard and auth.
    const bucket = isolatedBuckets.find(b => c.req.path.startsWith(b.prefix));
    const bucketLimit = bucket?.limit ?? limit;
    const bucketKey = bucket ? `global:${bucket.name}:${clientIp}` : `global:${clientIp}`;

    if (!redis) {
      // Redis unavailable — use in-memory fallback so requests are still metered.
      if (!inMemoryFallbackLogged) {
        console.warn('[RateLimit] Redis unavailable, using in-memory fallback');
        inMemoryFallbackLogged = true;
      }
      cleanupExpiredEntries();

      const now = Date.now();
      const entry = inMemoryCounters.get(bucketKey);

      if (entry && entry.resetAt > now) {
        if (entry.count >= bucketLimit) {
          c.header('X-RateLimit-Limit', String(bucketLimit));
          c.header('X-RateLimit-Remaining', '0');
          c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
          c.header('Retry-After', String(windowSeconds));
          return c.json({ error: 'Too many requests' }, 429);
        }
        entry.count++;
      } else {
        if (inMemoryCounters.size >= MAX_IN_MEMORY_ENTRIES) {
          // Map full — reject to prevent OOM. Still advertise Retry-After:
          // clients that honour it (the remote-desktop viewer poll does) would
          // otherwise have no signal and keep retrying at full rate.
          c.header('Retry-After', String(windowSeconds));
          return c.json({ error: 'Too many requests' }, 429);
        }
        inMemoryCounters.set(bucketKey, { count: 1, resetAt: now + windowMs });
      }

      return next();
    }

    const result = await rateLimiter(redis, bucketKey, bucketLimit, windowSeconds);

    // Always set rate limit headers so clients can self-throttle
    c.header('X-RateLimit-Limit', String(bucketLimit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));

    if (!result.allowed) {
      c.header('Retry-After', String(windowSeconds));
      return c.json({ error: 'Too many requests' }, 429);
    }

    return next();
  };
}
