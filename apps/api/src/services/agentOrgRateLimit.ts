import type { Redis } from 'ioredis';
import { and, count, eq, ne } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';

/**
 * Per-organization agent rate-limit sizing (issue #2728).
 *
 * The org bucket exists to stop one tenant's fleet saturating shared
 * resources. It used to be a flat 600 req/min for every org regardless of
 * size — the repo docs described it as "sized for ~5 active agents per org",
 * on a product that targets 10,000+ agents.
 *
 * A steady-state agent makes ~2 req/min (60s heartbeat + 180s process sample +
 * the 5/15-minute inventory sends), so a flat 600 saturates at roughly 300
 * devices — and far sooner in practice, because agents that started together
 * tick together: every 15th heartbeat each agent fires ~6-7 requests at once,
 * so a ~100-device org in phase can present ~700 requests within one second of
 * a 60-second sliding window.
 *
 * The consequence was not a slow-down but silent data loss: the once-per-24h
 * patch-inventory PUT is the traffic most likely to lose the race against
 * constant heartbeats, and a rejected patch upload left the device's posture
 * stale for a full scan interval.
 *
 * Two changes here:
 *  1. The ceiling scales with the org's enrolled device count, between a floor
 *     (the previous default, so small orgs are unchanged) and a hard platform
 *     ceiling (so the tenant-containment property survives).
 *  2. A reserved lane keeps low-frequency durable ingest (patch/inventory
 *     uploads) admissible when the main bucket has been drained by
 *     high-frequency heartbeat traffic.
 */

/** Floor — the historical flat default. Small orgs see no behavior change. */
export const DEFAULT_AGENT_ORG_RATE_LIMIT = 600;
/**
 * Per-device allowance used to scale the ceiling. A steady-state agent uses
 * ~2 req/min, so 12 leaves ~6x headroom for synchronized bursts, manual scans,
 * remote sessions and command traffic without being effectively unlimited.
 */
export const DEFAULT_AGENT_ORG_RATE_LIMIT_PER_DEVICE = 12;
/**
 * Hard platform ceiling. Without this the linear multiplier would defeat the
 * point of a tenant guardrail — a buggy agent release across a huge fleet
 * could otherwise consume unbounded capacity.
 */
export const DEFAULT_AGENT_ORG_RATE_LIMIT_MAX = 20_000;
/**
 * Fraction of the org ceiling reserved for low-frequency durable ingest. Only
 * consulted once the main bucket is already exhausted, so it costs nothing on
 * the steady-state path.
 */
export const RESERVED_INGEST_FRACTION = 0.2;

export const AGENT_ORG_RATE_WINDOW_SECONDS = 60;
/** Device-count cache TTL. Bounds how long a newly-enrolled fleet can be sized low. */
export const DEVICE_COUNT_CACHE_TTL_SECONDS = 300;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return raw;
}

/**
 * Endpoints carrying low-frequency, high-value inventory that must not be
 * starved by heartbeat volume. These fire once per 15 minutes to once per 24
 * hours per device, so admitting them from a reserved lane cannot itself
 * become a source of load — but dropping one silently corrupts operator-facing
 * posture until the next scan.
 */
const RESERVED_INGEST_PATTERN =
  /\/(patches|patches\/pending|patches\/installed|inventory|hardware|software|eventlogs)\/?$/;

export function isReservedIngestPath(path: string): boolean {
  return RESERVED_INGEST_PATTERN.test(path);
}

/** Exported for tests — the sizing math, free of Redis/DB. */
export function computeOrgRateLimit(deviceCount: number): number {
  const perDevice = positiveIntFromEnv(
    'AGENT_ORG_RATE_LIMIT_PER_DEVICE',
    DEFAULT_AGENT_ORG_RATE_LIMIT_PER_DEVICE,
  );
  const floor = positiveIntFromEnv('AGENT_ORG_RATE_LIMIT_PER_MIN', DEFAULT_AGENT_ORG_RATE_LIMIT);
  const ceiling = positiveIntFromEnv('AGENT_ORG_RATE_LIMIT_MAX', DEFAULT_AGENT_ORG_RATE_LIMIT_MAX);

  const safeCount = Number.isFinite(deviceCount) && deviceCount > 0 ? Math.floor(deviceCount) : 0;
  const scaled = safeCount * perDevice;
  // Guard against a misconfigured ceiling below the floor.
  return Math.min(Math.max(scaled, floor), Math.max(ceiling, floor));
}

export function computeReservedIngestLimit(orgLimit: number): number {
  return Math.max(1, Math.ceil(orgLimit * RESERVED_INGEST_FRACTION));
}

function deviceCountCacheKey(orgId: string): string {
  return `agent_org_devcount:${orgId}`;
}

/**
 * Enrolled device count for an org, cached in Redis.
 *
 * Never runs an uncached COUNT on the hot auth path more than once per
 * {@link DEVICE_COUNT_CACHE_TTL_SECONDS} per org. Returns null when the count
 * can't be determined, so the caller can fall back to the floor rather than
 * inventing a ceiling.
 */
export async function getCachedOrgDeviceCount(
  redis: Redis | null,
  orgId: string,
): Promise<number | null> {
  if (redis) {
    try {
      const cached = await redis.get(deviceCountCacheKey(orgId));
      if (cached !== null) {
        const parsed = Number.parseInt(cached, 10);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      }
    } catch (err) {
      // Cache read failure is not fatal — fall through to the DB.
      console.error('[agentOrgRateLimit] device-count cache read failed', err);
    }
  }

  let deviceCount: number;
  try {
    // System context: this is a rate-limiting decision made during
    // authentication, before any tenant DB context exists.
    const rows = await withSystemDbAccessContext(async () =>
      db
        .select({ value: count() })
        .from(devices)
        .where(and(eq(devices.orgId, orgId), ne(devices.status, 'decommissioned'))),
    );
    deviceCount = rows[0]?.value ?? 0;
  } catch (err) {
    // Fail to the floor, not to a generous ceiling: an unavailable DB is not a
    // reason to widen a tenant guardrail.
    console.error('[agentOrgRateLimit] device count query failed', { orgId, err });
    return null;
  }

  if (redis) {
    try {
      await redis.set(
        deviceCountCacheKey(orgId),
        String(deviceCount),
        'EX',
        DEVICE_COUNT_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      console.error('[agentOrgRateLimit] device-count cache write failed', err);
    }
  }

  return deviceCount;
}

/**
 * Invalidate the cached device count for an org. Call on enrollment and on
 * device removal so a growing fleet isn't throttled against a stale count for
 * up to the TTL. Best-effort: the TTL is the backstop when this is missed.
 */
export async function invalidateOrgDeviceCount(
  redis: Redis | null,
  orgId: string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(deviceCountCacheKey(orgId));
  } catch (err) {
    console.error('[agentOrgRateLimit] device-count cache invalidation failed', err);
  }
}

/** Resolve the effective per-org ceiling for this request. */
export async function resolveOrgRateLimit(
  redis: Redis | null,
  orgId: string,
): Promise<number> {
  const deviceCount = await getCachedOrgDeviceCount(redis, orgId);
  if (deviceCount === null) {
    return positiveIntFromEnv('AGENT_ORG_RATE_LIMIT_PER_MIN', DEFAULT_AGENT_ORG_RATE_LIMIT);
  }
  return computeOrgRateLimit(deviceCount);
}
