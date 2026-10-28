/**
 * The "this device is the source of an open reattach intent" marker (#8318
 * §6.2, review of wave 1b-2 finding 12).
 *
 * Every rebind-capable heartbeat must learn whether to carry the signed
 * `rebind` directive. Looking the intent up opens a DB transaction per beat,
 * on the hottest agent path, for something true of almost no device. The
 * marker turns that into one Redis GET: the beat opens the DB transaction
 * only when `reattach-intent:source:<deviceId>` exists.
 *
 *  - Set (value = the intent id, TTL = the intent's expiry) after the intent
 *    is created; re-armed to the staged expiry at phase 1.
 *  - Deleted when the intent ends (cancel, expiry, confirm), compare-and-
 *    delete on the intent id so a newer intent's marker survives. The TTL
 *    removes it anyway when a deletion is lost.
 *  - Redis unavailable or erroring: no marker, so no directive this beat.
 *    Harmless: the next beat asks again, and phase 1 and confirm never rely
 *    on the marker.
 *
 * Every function is best-effort and never throws. Call them with no DB
 * context held (they are Redis round trips).
 */
import { getRedis } from '../redis';

const MARKER_PREFIX = 'reattach-intent:source:';

export function reattachSourceMarkerKey(deviceId: string): string {
  return `${MARKER_PREFIX}${deviceId}`;
}

// Server-side, token-guarded (the intent id comes in as ARGV, never
// interpolated), like the presence leases (agentPresence.ts).
const EXTEND_IF_INTENT_MATCHES_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return 1
`;

const DELETE_IF_INTENT_MATCHES_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

function redisOrNull(): ReturnType<typeof getRedis> {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

function warn(action: string, deviceId: string, err: unknown): void {
  console.warn(`[deviceReattach] source marker ${action} failed for device ${deviceId}:`, err instanceof Error ? err.message : String(err));
}

/** Arm the marker until `expiresAt`. Returns whether it was written. */
export async function setReattachSourceMarker(deviceId: string, intentId: string, expiresAt: Date): Promise<boolean> {
  const redis = redisOrNull();
  if (!redis) return false;
  const ttlMs = expiresAt.getTime() - Date.now();
  if (ttlMs <= 0) return false;
  try {
    await redis.set(reattachSourceMarkerKey(deviceId), intentId, 'PX', ttlMs);
    return true;
  } catch (err) {
    warn('set', deviceId, err);
    return false;
  }
}

/** Move the marker's expiry to `expiresAt`, only while it still names this intent. */
export async function extendReattachSourceMarker(deviceId: string, intentId: string, expiresAt: Date): Promise<boolean> {
  const redis = redisOrNull();
  if (!redis) return false;
  try {
    const res = await redis.eval(EXTEND_IF_INTENT_MATCHES_LUA, 1, reattachSourceMarkerKey(deviceId), intentId, String(expiresAt.getTime()));
    return res === 1;
  } catch (err) {
    warn('extend', deviceId, err);
    return false;
  }
}

/** Drop the marker, only while it still names this intent. */
export async function clearReattachSourceMarker(deviceId: string, intentId: string): Promise<boolean> {
  const redis = redisOrNull();
  if (!redis) return false;
  try {
    const res = await redis.eval(DELETE_IF_INTENT_MATCHES_LUA, 1, reattachSourceMarkerKey(deviceId), intentId);
    return res === 1;
  } catch (err) {
    warn('clear', deviceId, err);
    return false;
  }
}

/** Is there a marker for this device? False when Redis cannot answer. */
export async function hasReattachSourceMarker(deviceId: string): Promise<boolean> {
  const redis = redisOrNull();
  if (!redis) return false;
  try {
    const value = await redis.get(reattachSourceMarkerKey(deviceId));
    return typeof value === 'string' && value.length > 0;
  } catch {
    return false;
  }
}
