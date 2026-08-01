import type { Redis } from 'ioredis';
import { and, count, eq, ne } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { captureException } from './sentry';

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
 * Endpoints carrying durable inventory that must not be starved by heartbeat
 * volume. These fire roughly once per 15 minutes to once per 24 hours per
 * device, so admitting them from a reserved lane cannot itself become a
 * meaningful source of load — but dropping one silently corrupts
 * operator-facing posture until the next scan, which is the #2728 symptom.
 *
 * Derived from the agent's `sendInventoryData` call sites
 * (agent/internal/heartbeat/heartbeat.go), cross-checked against the mounted
 * routes in routes/agents/. Note that `sendInventory()` fans out EIGHT of
 * these as one 15-minute batch (software, disks, network, changes,
 * connections, registry-state, config-state, warranty-info) — admitting only
 * part of that batch would leave the rest to go stale exactly as patch posture
 * did, so the batch is kept whole.
 *
 * Endpoints in AGENT_EXCLUDED_INGEST_ENDPOINTS are deliberately left out.
 * `agentOrgRateLimit.test.ts` parses the agent source and fails if any
 * `sendInventoryData` endpoint appears in neither list, so a new upload can't
 * silently fall out of the lane.
 */
export const AGENT_RESERVED_INGEST_ENDPOINTS = [
  'patches',
  'patches/pending',
  'patches/installed',
  'hardware',
  'software',
  'disks',
  'network',
  'changes',
  'connections',
  'registry-state',
  'config-state',
  'warranty-info',
  'eventlogs',
  'management/posture',
] as const;

/**
 * Agent upload endpoints deliberately NOT given reserved capacity, with the
 * reason. These run on a 5-minute cadence — frequent enough that reserving
 * capacity for them would defeat the lane's purpose, and recent enough that a
 * single dropped upload is corrected within minutes rather than a day.
 */
export const AGENT_EXCLUDED_INGEST_ENDPOINTS = [
  'security/status',
  'security/recovery-keys',
  'sessions',
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest-first so a shorter prefix (`patches`) can't shadow a longer sibling
// (`patches/pending`). The `/?$` anchor makes this correct either way, but the
// explicit ordering means it doesn't depend on backtracking to stay correct.
const RESERVED_INGEST_PATTERN = new RegExp(
  `/(${[...AGENT_RESERVED_INGEST_ENDPOINTS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})/?$`,
);

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
    // reason to widen a tenant guardrail. But this is loud, not silent — for a
    // large fleet the ceiling collapses to the floor, which will 429 most of
    // the org, so it needs to reach Sentry and not just stdout.
    console.error(
      `[agentOrgRateLimit] device count query failed for org ${orgId} — falling back to the rate-limit floor; a large fleet will be throttled`,
      err,
    );
    captureException(err, undefined, { service: 'agentOrgRateLimit', orgId });
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
 * Invalidate the cached device count for an org.
 *
 * Wired into the two paths where a stale count would matter most: enrollment
 * (a fleet rollout must not be throttled against a smaller count) and
 * permanent device deletion.
 *
 * It is deliberately NOT wired into every path that can change the counted
 * set — decommission, manual provisioning and cross-org moves also shift it.
 * {@link DEVICE_COUNT_CACHE_TTL_SECONDS} is the real guarantee, and those
 * paths only ever leave the count slightly HIGH for up to the TTL, which
 * widens the ceiling marginally rather than throttling anyone. A decommissioned
 * device also can't authenticate at all (agentAuth rejects it before the rate
 * limiter), so it contributes no traffic against the ceiling it inflates.
 *
 * Best-effort: failures are logged and swallowed.
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
