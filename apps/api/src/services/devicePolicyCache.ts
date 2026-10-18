/**
 * Device-keyed Redis caches of resolved heartbeat policy config (#8257).
 *
 * The helper, event-log, hardware-monitoring, monitoring and PAM resolvers
 * cache their answer per device for up to 120 s. Keyed by device id alone, an
 * entry written while the device was in org A stayed servable after the device
 * moved to org B: another tenant's resolved config. Every entry is therefore
 * stored as `{ orgId, settings }` and served only to a reader that names the
 * same org. The org move also deletes the device's entries
 * ({@link invalidateDevicePolicyCaches}), but the org check is the guarantee:
 * a beat already in flight when the move commits can still write an entry,
 * and that entry is bound to the old org.
 *
 * Keys: the org-bound entries live under NEW keys (`<feature>:settings:v2:
 * device:<id>`), not the old `<feature>:settings:device:<id>`. During a rolling
 * deploy an API replica on the previous release still reads the old key as
 * bare settings; given an envelope it would see `enabled: undefined` and
 * deliver "helper disabled" / "UAC interception off". Separate keys mean
 * neither release ever parses the other's format. The old keys expire within
 * their 120 s TTL once no old replica is left; the org move deletes them too.
 *
 * Time sync and workload inventory store their own `orgId` inside the cached
 * value and check it on read (their format is unchanged); they take their key
 * from here so the org move invalidates them too.
 *
 * Which org: the hierarchy the caller passed (the heartbeat loads it every
 * beat and has already checked it against the agent's org), else the caller's
 * `orgId`. A caller that knows neither gets no cache at all — resolution still
 * runs, it just is not cached. Naming both with different orgs throws: the
 * value would be resolved for one org and bound to the other.
 */
import type { DevicePolicySetOpts } from './devicePolicySet';
import { hierarchyFor } from './deviceHierarchy';
import { policySetFor } from './devicePolicySet';
import { getRedis } from './redis';

/** Features whose entries this module stores org-bound. */
export const DEVICE_POLICY_CACHE_FEATURES = ['helper', 'eventlog', 'hwmon', 'monitoring', 'pam'] as const;
export type DevicePolicyCacheFeature = (typeof DEVICE_POLICY_CACHE_FEATURES)[number];

/** Features that keep their own org check inside the cached value. */
export const SELF_BOUND_DEVICE_SETTINGS_FEATURES = ['timesync', 'workloads'] as const;
export type SelfBoundDeviceSettingsFeature = (typeof SELF_BOUND_DEVICE_SETTINGS_FEATURES)[number];

export function devicePolicyCacheKey(feature: DevicePolicyCacheFeature, deviceId: string): string {
  return `${feature}:settings:v2:device:${deviceId}`;
}

export function selfBoundDeviceSettingsKey(feature: SelfBoundDeviceSettingsFeature, deviceId: string): string {
  return `${feature}:settings:device:${deviceId}`;
}

/** The pre-#8257 unbound key, still written by an API replica on the previous release. */
function legacyUnboundKey(feature: DevicePolicyCacheFeature, deviceId: string): string {
  return `${feature}:settings:device:${deviceId}`;
}

/** Every device-keyed policy cache key for the device: org-bound, legacy unbound, and self-bound. */
export function allDevicePolicyCacheKeys(deviceId: string): string[] {
  return [
    ...DEVICE_POLICY_CACHE_FEATURES.map((feature) => devicePolicyCacheKey(feature, deviceId)),
    ...DEVICE_POLICY_CACHE_FEATURES.map((feature) => legacyUnboundKey(feature, deviceId)),
    ...SELF_BOUND_DEVICE_SETTINGS_FEATURES.map((feature) => selfBoundDeviceSettingsKey(feature, deviceId)),
  ];
}

export interface DevicePolicyCacheOpts extends DevicePolicySetOpts {
  /**
   * The device's org as the caller knows it. Binds the cache entry when no
   * hierarchy is passed; must agree with the hierarchy when one is.
   */
  orgId?: string;
}

export class DevicePolicyCacheOrgMismatchError extends Error {
  constructor(readonly hierarchyOrgId: string, readonly callerOrgId: string, readonly deviceId: string) {
    super(`device ${deviceId}: policy cache org ${callerOrgId} contradicts the passed hierarchy org ${hierarchyOrgId}`);
    this.name = 'DevicePolicyCacheOrgMismatchError';
  }
}

/** The org a device's cache entry is bound to, or null when the caller cannot say (no caching). */
export function devicePolicyCacheOrg(deviceId: string, opts: DevicePolicyCacheOpts | undefined): string | null {
  const hierarchy = hierarchyFor(deviceId, opts) ?? policySetFor(deviceId, opts)?.hierarchy;
  const callerOrgId = opts?.orgId;
  if (hierarchy && callerOrgId && hierarchy.orgId !== callerOrgId) {
    throw new DevicePolicyCacheOrgMismatchError(hierarchy.orgId, callerOrgId, deviceId);
  }
  return hierarchy?.orgId ?? callerOrgId ?? null;
}

interface CacheEntry {
  orgId: string;
  settings: unknown;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { orgId?: unknown }).orgId === 'string'
    && 'settings' in value;
}

/**
 * The device's cached value for `orgId`, or null on a miss, an entry bound to
 * another org, a malformed entry, or a Redis error (logged; never thrown).
 * `parse` may validate; a parse error is treated as a miss.
 */
export async function readDevicePolicyCache<T>(
  feature: DevicePolicyCacheFeature,
  deviceId: string,
  orgId: string | null,
  parse: (settings: unknown) => T = (settings) => settings as T,
): Promise<T | null> {
  if (!orgId) return null;
  let raw: string | null;
  try {
    const redis = getRedis();
    if (!redis) return null;
    raw = await redis.get(devicePolicyCacheKey(feature, deviceId));
  } catch (cacheErr) {
    console.warn(`[${feature}] Redis cache read failed for device ${deviceId}:`, cacheErr);
    return null;
  }
  if (!raw) return null;
  try {
    const entry: unknown = JSON.parse(raw);
    if (!isCacheEntry(entry) || entry.orgId !== orgId) return null;
    return parse(entry.settings);
  } catch (parseErr) {
    // Stale or malformed entry (e.g. a settings schema changed under a live
    // entry): re-resolve; the resolver's write replaces it.
    console.warn(`[${feature}] cached policy entry unparseable for device ${deviceId}; treating as a miss:`, parseErr);
    return null;
  }
}

/** Caches `settings` for the device, bound to `orgId`. No-op without an org or Redis; Redis errors are logged. */
export async function writeDevicePolicyCache(
  feature: DevicePolicyCacheFeature,
  deviceId: string,
  orgId: string | null,
  settings: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (!orgId) return;
  try {
    const redis = getRedis();
    if (!redis) return;
    const entry: CacheEntry = { orgId, settings };
    await redis.set(devicePolicyCacheKey(feature, deviceId), JSON.stringify(entry), 'EX', ttlSeconds);
  } catch (cacheErr) {
    console.warn(`[${feature}] Redis cache write failed for device ${deviceId}:`, cacheErr);
  }
}

/**
 * Deletes every device-keyed policy cache entry for the device. Called after
 * an org move commits. Best-effort: a Redis error is logged, never thrown (the
 * org binding above still keeps a surviving entry from being served).
 */
export async function invalidateDevicePolicyCaches(deviceId: string): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.del(...allDevicePolicyCacheKeys(deviceId));
  } catch (err) {
    console.warn(`[devicePolicyCache] failed to invalidate policy caches for device ${deviceId}:`, err);
  }
}
