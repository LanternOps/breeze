import { getRedis } from '../redis';

/**
 * Customer-portal state backend + rate limiter.
 *
 * Lives in the SERVICES layer on purpose. `services/portal/reportsSelfService`
 * rate-limits report generation, and a service importing
 * `routes/portal/helpers` for it dragged `routes/auth/helpers` → the services
 * barrel → `commandQueue` → `agentWs` → the discovery worker into every module
 * graph that touches portal flags (#4562 W10 broke `orgPortalSettings.test.ts`
 * that way). Routes keep importing these names from `routes/portal/helpers` /
 * `routes/portal/schemas`, which re-export them.
 */

/** Sessions, tokens and rate-limit buckets live in Redis when set (or in production). */
export const PORTAL_USE_REDIS =
  process.env.PORTAL_STATE_BACKEND === 'redis' || process.env.NODE_ENV === 'production';

export const PORTAL_RATE_BUCKET_CAP = 50000;
export const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const PORTAL_RATE_LIMIT_REDIS_KEYS = {
  attempts: (key: string) => `portal:rl:attempts:${key}`,
  block: (key: string) => `portal:rl:block:${key}`,
};

export const portalRateLimitBuckets = new Map<string, {
  count: number;
  resetAtMs: number;
  blockedUntilMs: number;
  lastSeenAtMs: number;
}>();

let lastRateLimitSweepAtMs = 0;

// ============================================
// Map cap / sweep helpers
// ============================================

export function capMapByOldest<T>(
  map: Map<string, T>,
  cap: number,
  getAgeMs: (value: T) => number
) {
  if (map.size <= cap) {
    return;
  }

  const overflow = map.size - cap;
  const entries = Array.from(map.entries())
    .sort(([, left], [, right]) => getAgeMs(left) - getAgeMs(right));

  for (let i = 0; i < overflow; i++) {
    const key = entries[i]?.[0];
    if (key) {
      map.delete(key);
    }
  }
}

function sweepRateLimitBuckets(nowMs: number = Date.now()) {
  if (nowMs - lastRateLimitSweepAtMs < RATE_LIMIT_SWEEP_INTERVAL_MS) {
    return;
  }

  lastRateLimitSweepAtMs = nowMs;

  for (const [key, bucket] of portalRateLimitBuckets.entries()) {
    const stale = bucket.resetAtMs <= nowMs && bucket.blockedUntilMs <= nowMs;
    const idleTooLong = nowMs - bucket.lastSeenAtMs > RATE_LIMIT_SWEEP_INTERVAL_MS * 6;
    if (stale || idleTooLong) {
      portalRateLimitBuckets.delete(key);
    }
  }

  capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (bucket) => bucket.lastSeenAtMs);
}

// ============================================
// Rate limiting
// ============================================

export async function checkRateLimit(
  key: string,
  config: { windowMs: number; maxAttempts: number; blockMs: number },
  nowMs: number = Date.now()
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      if (process.env.NODE_ENV === 'production') {
        return { allowed: false, retryAfterSeconds: 60 };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const blockKey = PORTAL_RATE_LIMIT_REDIS_KEYS.block(key);
    const blockTtl = await redis.ttl(blockKey);
    if (blockTtl > 0) {
      return { allowed: false, retryAfterSeconds: blockTtl };
    }

    const attemptsKey = PORTAL_RATE_LIMIT_REDIS_KEYS.attempts(key);
    const windowSeconds = Math.ceil(config.windowMs / 1000);
    const count = await redis.incr(attemptsKey);
    if (count === 1) {
      await redis.expire(attemptsKey, windowSeconds);
    }

    if (count > config.maxAttempts) {
      const blockSeconds = Math.ceil(config.blockMs / 1000);
      await redis.setex(blockKey, blockSeconds, '1');
      return { allowed: false, retryAfterSeconds: blockSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  sweepRateLimitBuckets(nowMs);

  let bucket = portalRateLimitBuckets.get(key);
  if (!bucket || bucket.resetAtMs <= nowMs) {
    bucket = {
      count: 0,
      resetAtMs: nowMs + config.windowMs,
      blockedUntilMs: 0,
      lastSeenAtMs: nowMs
    };
  }

  if (bucket.blockedUntilMs > nowMs) {
    bucket.lastSeenAtMs = nowMs;
    portalRateLimitBuckets.set(key, bucket);
    capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (entry) => entry.lastSeenAtMs);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntilMs - nowMs) / 1000))
    };
  }

  bucket.count += 1;
  bucket.lastSeenAtMs = nowMs;

  if (bucket.count > config.maxAttempts) {
    bucket.blockedUntilMs = nowMs + config.blockMs;
    portalRateLimitBuckets.set(key, bucket);
    capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (entry) => entry.lastSeenAtMs);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(config.blockMs / 1000))
    };
  }

  portalRateLimitBuckets.set(key, bucket);
  capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (entry) => entry.lastSeenAtMs);
  return { allowed: true, retryAfterSeconds: 0 };
}
