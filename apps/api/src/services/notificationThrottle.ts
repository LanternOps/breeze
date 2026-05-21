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

  try {
    // Trim expired entries first so zcard reflects only the current window.
    await redis.zremrangebyscore(key, 0, windowStart);
    const count = await redis.zcard(key);

    if (count >= maxPerWindow) {
      // Already at cap — oldest entry tells us when one slot will free up.
      const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestTs = oldest.length >= 2 ? Number(oldest[1]) : now;
      return {
        allowed: false,
        currentCount: count,
        windowExpiresAt: oldestTs + windowSeconds * 1000
      };
    }

    // Record this delivery and refresh TTL so the key self-cleans.
    await redis.zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 10)}`);
    await redis.expire(key, windowSeconds + TTL_BUFFER_SECONDS);

    return {
      allowed: true,
      currentCount: count + 1,
      windowExpiresAt: now + windowSeconds * 1000
    };
  } catch (err) {
    console.warn(`[NotificationThrottle] Redis error for key=${key}, fail-open:`, err);
    return { allowed: true, currentCount: 0, windowExpiresAt: 0, skipped: 'redis-error' };
  }
}
