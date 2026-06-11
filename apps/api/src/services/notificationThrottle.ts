/**
 * Notification Throttle Service (Feature #4)
 *
 * Redis-backed sliding-window counter that caps notification deliveries per
 * channel per scope (typically per device). Defense-in-depth against alert
 * storms — distinct from `rate-limit.ts` (per-org/per-type) and from
 * alertCooldown (per-rule cooldown). Fail-open: if Redis is unavailable or
 * the channel has no cap configured, throttle is skipped.
 *
 * Storage: `breeze:notif:throttle:<channelId>:<scopeKey>` as a sorted set of
 * `timestamp -> nonce`. Old entries are trimmed before each check.
 *
 * Concurrency: all Redis ops are bundled into a single `multi()` so the
 * check-and-add is atomic. Without this, N concurrent dispatcher workers
 * can each read `count = limit - 1`, all pass the cap check, then all
 * `zadd` — overshooting the cap by up to N. The atomic `multi()` matches
 * the pattern in `rate-limit.ts:rateLimiter`. (See #796 review.)
 */
import type { Redis } from 'ioredis';
import { getRedis } from './redis';

const TTL_BUFFER_SECONDS = 60;

export interface ThrottleResult {
  allowed: boolean;
  currentCount: number;
  windowExpiresAt: number;
  skipped?: 'unlimited' | 'redis-unavailable' | 'redis-error';
}

/**
 * Check whether a notification may be delivered under the channel's throttle.
 *
 * @param channelId notification_channels.id
 * @param scopeKey  scope discriminator, e.g. `device:<deviceId>` or `rule:<ruleId>`
 * @param maxPerWindow null/0/undefined = unlimited (allowed without Redis touch)
 * @param windowSeconds sliding-window size in seconds (default 3600)
 * @param redisOverride inject a Redis client (for tests); production passes none.
 */
export async function checkNotificationThrottle(
  channelId: string,
  scopeKey: string,
  maxPerWindow: number | null | undefined,
  windowSeconds: number,
  redisOverride?: Redis | null
): Promise<ThrottleResult> {
  if (!maxPerWindow || maxPerWindow <= 0) {
    return { allowed: true, currentCount: 0, windowExpiresAt: 0, skipped: 'unlimited' };
  }

  const redis = redisOverride !== undefined ? redisOverride : getRedis();
  if (!redis) {
    // Fail-open: better to deliver than to lose alerts because Redis is down.
    console.warn(`[NotificationThrottle] Redis unavailable, fail-open for channel=${channelId} scope=${scopeKey}`);
    return { allowed: true, currentCount: 0, windowExpiresAt: 0, skipped: 'redis-unavailable' };
  }

  const key = `breeze:notif:throttle:${channelId}:${scopeKey}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    // Single atomic transaction:
    //   1. trim expired entries from the sorted set
    //   2. record THIS delivery (zadd) — note: we record unconditionally, then
    //      decide allow/deny based on the post-add count. This matches the
    //      sliding-window-counter semantic used by rate-limit.ts. Under storm,
    //      the over-cap attempts each still cost a slot, which makes the
    //      backpressure slightly more aggressive than the nominal cap — that's
    //      desired for storm dampening.
    //   3. read the new count + the oldest score
    //   4. refresh the TTL
    const results = await redis
      .multi()
      .zremrangebyscore(key, 0, windowStart)
      .zadd(key, now, member)
      .zcard(key)
      .zrange(key, 0, 0, 'WITHSCORES')
      .expire(key, windowSeconds + TTL_BUFFER_SECONDS)
      .exec();

    if (!results) {
      // Transaction aborted (rare — WATCH conflict or driver-level error).
      // Fail-open per the original behavior.
      console.warn(`[NotificationThrottle] multi.exec returned null for key=${key}, fail-open`);
      return { allowed: true, currentCount: 0, windowExpiresAt: 0, skipped: 'redis-error' };
    }

    const countRaw = results[2]?.[1];
    const count = typeof countRaw === 'number' ? countRaw : Number(countRaw ?? 0);
    const oldestRaw = results[3]?.[1];
    const oldestTs = Array.isArray(oldestRaw) && oldestRaw.length >= 2
      ? Number(oldestRaw[1])
      : now;

    if (count > maxPerWindow) {
      // Over-cap: roll back the entry we just added so we don't poison the
      // window for legitimate calls that arrive later in this same second.
      // (Best-effort — failure of this cleanup is non-fatal because the TTL
      // will eventually clear it anyway.)
      redis.zrem(key, member).catch((err) => {
        console.warn(`[NotificationThrottle] zrem cleanup failed for ${key}:`, err);
      });
      return {
        allowed: false,
        currentCount: count - 1, // report the count BEFORE our (now-removed) entry
        windowExpiresAt: oldestTs + windowSeconds * 1000
      };
    }

    return {
      allowed: true,
      currentCount: count,
      windowExpiresAt: now + windowSeconds * 1000
    };
  } catch (err) {
    console.warn(`[NotificationThrottle] Redis error for key=${key}, fail-open:`, err);
    return { allowed: true, currentCount: 0, windowExpiresAt: 0, skipped: 'redis-error' };
  }
}
