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

// In-memory fallback when Redis is unavailable
// Stores cooldown expiry timestamps keyed by "ruleId:deviceId"
const memoryCooldowns: Map<string, number> = new Map();

/**
 * Check and clean up expired entries from in-memory cooldowns
 */
function memoryHasCooldown(key: string): boolean {
  const expiry = memoryCooldowns.get(key);
  if (expiry === undefined) return false;
  if (Date.now() >= expiry) {
    memoryCooldowns.delete(key);
    return false;
  }
  return true;
}

/**
 * Set an in-memory cooldown entry
 */
function memorySetCooldown(key: string, cooldownMinutes: number): void {
  const expiryMs = Date.now() + cooldownMinutes * 60 * 1000;
  memoryCooldowns.set(key, expiryMs);
}

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
    // Fail closed: suppress duplicate alerts when Redis is down
    console.error('[AlertCooldown] Redis unavailable, using in-memory fallback (fail-closed)');
    const memKey = `${ruleId}:${deviceId}`;
    return memoryHasCooldown(memKey);
  }

  const redis = getRedis();
  if (!redis) {
    console.error('[AlertCooldown] Redis client null, using in-memory fallback (fail-closed)');
    const memKey = `${ruleId}:${deviceId}`;
    return memoryHasCooldown(memKey);
  }

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
    console.error('[AlertCooldown] Redis unavailable, setting in-memory cooldown fallback');
    const memKey = `${ruleId}:${deviceId}`;
    memorySetCooldown(memKey, cooldownMinutes);
    return;
  }

  const redis = getRedis();
  if (!redis) {
    console.error('[AlertCooldown] Redis client null, setting in-memory cooldown fallback');
    const memKey = `${ruleId}:${deviceId}`;
    memorySetCooldown(memKey, cooldownMinutes);
    return;
  }

  const key = buildCooldownKey(ruleId, deviceId);

  // Phase 6c: Adaptive cooldown — increase multiplier on repeated triggers
  const adaptiveKey = `${COOLDOWN_PREFIX}:adaptive:${ruleId}:${deviceId}`;
  let multiplier = 1;

  try {
    const existing = await redis.get(adaptiveKey);
    if (existing) {
      const parsed = JSON.parse(existing);
      // If re-triggered within 1 hour of last cooldown set, double the multiplier (cap at 4x)
      if (parsed.multiplier && Date.now() - parsed.setAt < 3600_000) {
        multiplier = Math.min(parsed.multiplier * 2, 4);
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`[AlertCooldown] Corrupt adaptive state for rule=${ruleId} device=${deviceId}, resetting multiplier`);
    } else {
      console.error(`[AlertCooldown] Failed to read adaptive state for rule=${ruleId} device=${deviceId}:`, error instanceof Error ? error.message : error);
    }
  }

  const effectiveMinutes = cooldownMinutes * multiplier;
  const ttlSeconds = effectiveMinutes * 60;

  // Set key with TTL - value includes multiplier for adaptive cooldown
  await redis.setex(key, ttlSeconds, JSON.stringify({ setAt: Date.now(), multiplier }));

  // Track adaptive state (1 hour TTL)
  await redis.setex(adaptiveKey, 3600, JSON.stringify({ setAt: Date.now(), multiplier }));

  if (multiplier > 1) {
    console.log(`[AlertCooldown] Set adaptive cooldown for rule=${ruleId} device=${deviceId} for ${effectiveMinutes}min (${multiplier}x multiplier)`);
  } else {
    console.log(`[AlertCooldown] Set cooldown for rule=${ruleId} device=${deviceId} for ${cooldownMinutes}min`);
  }
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
    console.warn('[AlertCooldown] Redis unavailable, cannot clear cooldown');
    return;
  }

  const redis = getRedis();
  if (!redis) {
    console.warn('[AlertCooldown] Redis client null, cannot clear cooldown');
    return;
  }

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
    console.warn('[AlertCooldown] Redis unavailable, cannot extend cooldown');
    return;
  }

  const redis = getRedis();
  if (!redis) {
    console.warn('[AlertCooldown] Redis client null, cannot extend cooldown');
    return;
  }

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

// ============================================
// Config Policy Alert Rule Cooldowns
// ============================================

// Key pattern for config policy alert rule cooldowns uses a 'cpar:' segment
// to distinguish from legacy standalone alert rule cooldowns.
const CONFIG_POLICY_COOLDOWN_PREFIX = `${COOLDOWN_PREFIX}:cpar`;

/**
 * Build Redis key for config policy alert rule cooldown tracking
 */
function buildConfigPolicyCooldownKey(ruleId: string, deviceId: string): string {
  return `${CONFIG_POLICY_COOLDOWN_PREFIX}:${ruleId}:${deviceId}`;
}

/**
 * Check if a cooldown is currently active for a config policy alert rule / device combination
 *
 * @param ruleId - Config policy alert rule ID (from config_policy_alert_rules)
 * @param deviceId - Device ID
 * @returns true if cooldown is active (should NOT create alert), false otherwise
 */
export async function isConfigPolicyRuleCooling(ruleId: string, deviceId: string): Promise<boolean> {
  if (!isRedisAvailable()) {
    console.error('[AlertCooldown] Redis unavailable, using in-memory fallback (fail-closed) [config policy]');
    const memKey = `cpar:${ruleId}:${deviceId}`;
    return memoryHasCooldown(memKey);
  }

  const redis = getRedis();
  if (!redis) {
    console.error('[AlertCooldown] Redis client null, using in-memory fallback (fail-closed) [config policy]');
    const memKey = `cpar:${ruleId}:${deviceId}`;
    return memoryHasCooldown(memKey);
  }

  const key = buildConfigPolicyCooldownKey(ruleId, deviceId);
  const exists = await redis.exists(key);

  return exists === 1;
}

/**
 * Set a cooldown for a config policy alert rule / device combination
 *
 * @param ruleId - Config policy alert rule ID (from config_policy_alert_rules)
 * @param deviceId - Device ID
 * @param cooldownMinutes - Duration of cooldown in minutes
 */
export async function markConfigPolicyRuleCooldown(
  ruleId: string,
  deviceId: string,
  cooldownMinutes: number
): Promise<void> {
  if (!isRedisAvailable()) {
    console.error('[AlertCooldown] Redis unavailable, setting in-memory cooldown fallback [config policy]');
    const memKey = `cpar:${ruleId}:${deviceId}`;
    memorySetCooldown(memKey, cooldownMinutes);
    return;
  }

  const redis = getRedis();
  if (!redis) {
    console.error('[AlertCooldown] Redis client null, setting in-memory cooldown fallback [config policy]');
    const memKey = `cpar:${ruleId}:${deviceId}`;
    memorySetCooldown(memKey, cooldownMinutes);
    return;
  }

  const key = buildConfigPolicyCooldownKey(ruleId, deviceId);
  const ttlSeconds = cooldownMinutes * 60;

  await redis.setex(key, ttlSeconds, Date.now().toString());

  console.log(`[AlertCooldown] Set config policy cooldown for cpar=${ruleId} device=${deviceId} for ${cooldownMinutes}min`);
}

// ============================================
// Phase 6a: Flapping Detection
// ============================================

const FLAP_PREFIX = 'breeze:alerts:flap';

/**
 * Record a state transition (trigger or resolve) for flapping detection.
 * Stores a ring buffer of state transitions in Redis.
 */
export async function recordStateTransition(
  ruleId: string,
  deviceId: string,
  state: 'triggered' | 'resolved'
): Promise<void> {
  if (!isRedisAvailable()) {
    console.warn('[AlertCooldown] Redis unavailable, flapping detection disabled — state transition not recorded');
    return;
  }

  const redis = getRedis();
  if (!redis) {
    console.warn('[AlertCooldown] Redis client null, flapping detection disabled — state transition not recorded');
    return;
  }

  const key = `${FLAP_PREFIX}:${ruleId}:${deviceId}`;
  const entry = JSON.stringify({ state, timestamp: Date.now() });

  // Push to list and trim to last 20 entries
  await redis.rpush(key, entry);
  await redis.ltrim(key, -20, -1);
  // Expire after 30 minutes of inactivity
  await redis.expire(key, 1800);
}

/**
 * Check if a rule/device combination is flapping.
 * Returns true if there have been >= threshold state change recordings in the window.
 * Note: counts all recorded events, not only alternations between states.
 *
 * @param ruleId - Alert rule ID
 * @param deviceId - Device ID
 * @param windowMinutes - Time window to check (default: 10)
 * @param threshold - Number of transitions to consider flapping (default: 4)
 */
export async function isFlapping(
  ruleId: string,
  deviceId: string,
  windowMinutes: number = 10,
  threshold: number = 4
): Promise<boolean> {
  if (!isRedisAvailable()) {
    console.warn('[AlertCooldown] Redis unavailable, flapping detection disabled');
    return false;
  }

  const redis = getRedis();
  if (!redis) {
    console.warn('[AlertCooldown] Redis client null, flapping detection disabled');
    return false;
  }

  const key = `${FLAP_PREFIX}:${ruleId}:${deviceId}`;
  const entries = await redis.lrange(key, 0, -1);

  if (entries.length < threshold) return false;

  const windowStart = Date.now() - windowMinutes * 60 * 1000;
  let transitionCount = 0;

  for (const entry of entries) {
    try {
      const parsed = JSON.parse(entry);
      if (parsed.timestamp >= windowStart) {
        transitionCount++;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        console.error(`[AlertCooldown] Failed to parse flapping entry for rule=${ruleId} device=${deviceId}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  return transitionCount >= threshold;
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

    const filteredKeys = keys.filter(k => !k.includes(':adaptive:') && !k.includes(':cpar:'));

    for (const key of filteredKeys) {
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
