/**
 * Alert Cooldown Manager
 *
 * Redis-based cooldown tracking to prevent alert spam.
 * After an alert triggers, a cooldown period prevents the same alert
 * from triggering again for the same device/rule combination.
 */

import { getRedis, isRedisAvailable } from './redis';

// Key pattern for cooldown tracking
const COOLDOWN_PREFIX = 'breeze:alerts:cooldown';

/**
 * Build Redis key for cooldown tracking
 */
function buildCooldownKey(ruleId: string, deviceId: string): string {
  return `${COOLDOWN_PREFIX}:${ruleId}:${deviceId}`;
}

/**
 * Check if a cooldown is currently active for a rule/device combination
 *
 * @param ruleId - Alert rule ID
 * @param deviceId - Device ID
 * @returns true if cooldown is active (should NOT create alert), false otherwise
 */
export async function isCooldownActive(ruleId: string, deviceId: string): Promise<boolean> {
  if (!isRedisAvailable()) {
    // If Redis is unavailable, assume no cooldown (fail open)
    console.warn('[AlertCooldown] Redis unavailable, skipping cooldown check');
    return false;
  }

  const redis = getRedis();
  if (!redis) return false;

  const key = buildCooldownKey(ruleId, deviceId);
  const exists = await redis.exists(key);

  return exists === 1;
}

/**
 * Set a cooldown for a rule/device combination
 *
 * @param ruleId - Alert rule ID
 * @param deviceId - Device ID
 * @param cooldownMinutes - Duration of cooldown in minutes
 */
export async function setCooldown(
  ruleId: string,
  deviceId: string,
  cooldownMinutes: number
): Promise<void> {
  if (!isRedisAvailable()) {
    console.warn('[AlertCooldown] Redis unavailable, skipping cooldown set');
    return;
  }

  const redis = getRedis();
  if (!redis) return;

  const key = buildCooldownKey(ruleId, deviceId);
  const ttlSeconds = cooldownMinutes * 60;

  // Set key with TTL - value is timestamp when cooldown was set
  await redis.setex(key, ttlSeconds, Date.now().toString());

  console.log(`[AlertCooldown] Set cooldown for rule=${ruleId} device=${deviceId} for ${cooldownMinutes}min`);
}

/**
 * Clear cooldown for a rule/device combination
 * Used when an alert is manually resolved or suppressed
 *
 * @param ruleId - Alert rule ID
 * @param deviceId - Device ID
 */
export async function clearCooldown(ruleId: string, deviceId: string): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }

  const redis = getRedis();
  if (!redis) return;

  const key = buildCooldownKey(ruleId, deviceId);
  await redis.del(key);

  console.log(`[AlertCooldown] Cleared cooldown for rule=${ruleId} device=${deviceId}`);
}

/**
 * Get remaining cooldown time in seconds
 * Returns -1 if no cooldown exists, -2 if key exists but has no TTL
 *
 * @param ruleId - Alert rule ID
 * @param deviceId - Device ID
 * @returns Remaining seconds, or -1 if no cooldown
 */
export async function getCooldownRemaining(ruleId: string, deviceId: string): Promise<number> {
  if (!isRedisAvailable()) {
    return -1;
  }

  const redis = getRedis();
  if (!redis) return -1;

  const key = buildCooldownKey(ruleId, deviceId);
  const ttl = await redis.ttl(key);

  return ttl;
}

/**
 * Clear all cooldowns for a specific rule
 * Used when a rule is deleted or deactivated
 *
 * @param ruleId - Alert rule ID
 */
export async function clearRuleCooldowns(ruleId: string): Promise<number> {
  if (!isRedisAvailable()) {
    return 0;
  }

  const redis = getRedis();
  if (!redis) return 0;

  const pattern = `${COOLDOWN_PREFIX}:${ruleId}:*`;
  let cursor = '0';
  let deletedCount = 0;

  // Use SCAN to find all keys matching the pattern
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;

    if (keys.length > 0) {
      await redis.del(...keys);
      deletedCount += keys.length;
    }
  } while (cursor !== '0');

  console.log(`[AlertCooldown] Cleared ${deletedCount} cooldowns for rule=${ruleId}`);
  return deletedCount;
}

/**
 * Clear all cooldowns for a specific device
 * Used when a device is decommissioned
 *
 * @param deviceId - Device ID
 */
export async function clearDeviceCooldowns(deviceId: string): Promise<number> {
  if (!isRedisAvailable()) {
    return 0;
  }

  const redis = getRedis();
  if (!redis) return 0;

  const pattern = `${COOLDOWN_PREFIX}:*:${deviceId}`;
  let cursor = '0';
  let deletedCount = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;

    if (keys.length > 0) {
      await redis.del(...keys);
      deletedCount += keys.length;
    }
  } while (cursor !== '0');

  console.log(`[AlertCooldown] Cleared ${deletedCount} cooldowns for device=${deviceId}`);
  return deletedCount;
}

/**
 * Extend an existing cooldown
 * Used to extend cooldown when an alert is suppressed
 *
 * @param ruleId - Alert rule ID
 * @param deviceId - Device ID
 * @param additionalMinutes - Additional minutes to add
 */
export async function extendCooldown(
  ruleId: string,
  deviceId: string,
  additionalMinutes: number
): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }

  const redis = getRedis();
  if (!redis) return;

  const key = buildCooldownKey(ruleId, deviceId);
  const currentTtl = await redis.ttl(key);

  if (currentTtl > 0) {
    // Extend existing TTL
    const newTtl = currentTtl + (additionalMinutes * 60);
    await redis.expire(key, newTtl);
    console.log(`[AlertCooldown] Extended cooldown for rule=${ruleId} device=${deviceId} by ${additionalMinutes}min`);
  } else {
    // No existing cooldown, set a new one
    await setCooldown(ruleId, deviceId, additionalMinutes);
  }
}

/**
 * Get all active cooldowns for debugging/monitoring
 * Returns array of { ruleId, deviceId, remainingSeconds }
 */
export async function listActiveCooldowns(): Promise<Array<{
  ruleId: string;
  deviceId: string;
  remainingSeconds: number;
}>> {
  if (!isRedisAvailable()) {
    return [];
  }

  const redis = getRedis();
  if (!redis) return [];

  const results: Array<{ ruleId: string; deviceId: string; remainingSeconds: number }> = [];
  const pattern = `${COOLDOWN_PREFIX}:*:*`;
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;

    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 4) {
        const ruleId = parts[3];
        const deviceId = parts[4];
        const ttl = await redis.ttl(key);

        if (ttl && ttl > 0 && ruleId && deviceId) {
          results.push({
            ruleId,
            deviceId,
            remainingSeconds: ttl
          });
        }
      }
    }
  } while (cursor !== '0');

  return results;
}
