import type { Redis } from 'ioredis';
import { STORAGE_SESSION_CALLS_PER_MINUTE } from './backupStorageSessionBudget';

/**
 * Request-rate gate for brokered storage-session calls
 * (`/api/v1/agents/<id>/storage-sessions/<sessionId>/<op>` and the `…/object`
 * read), applied by agentAuthMiddleware IN PLACE OF the general agent buckets
 * (per-(agent, source-IP), per-agent and per-org).
 *
 * Why separate: a brokered backup makes one control-plane call per multipart
 * part and per small file. Charged to the general buckets, a fast transfer
 * exhausted the 30/min per-(agent, source-IP) bucket within a minute; the
 * agent's own heartbeats shared that bucket, were refused, and the device went
 * offline mid-backup. Storage traffic now spends only its own budget, so it can
 * never starve heartbeats, and heartbeats cannot starve it.
 *
 * Three sliding 60 s windows, all checked on every call:
 *   - per session (keyed by device AND session id):
 *       AGENT_STORAGE_SESSION_RATE_LIMIT = STORAGE_SESSION_CALLS_PER_MINUTE
 *       (600/min). One call per part: 10 parts/s is ~50 MiB/s even at the
 *       5 MiB minimum multipart part size, and ~640 MiB/s at the 64 MiB part
 *       size the server issues (STORAGE_WRITE_PART_SIZE_BYTES) — a fast LAN
 *       link. It is also 10 small-file resolves/s for a helper that does not
 *       batch. Equal to the session's own token bucket
 *       (backupStorageSessionBudget.ts), so this edge gate never refuses a call
 *       that bucket would admit; it exists so a flood is refused before any
 *       database work, and so a session id the caller invents cannot mint an
 *       unbounded supply of fresh buckets (see the device ceiling).
 *   - per device, across all its sessions:
 *       AGENT_STORAGE_DEVICE_RATE_LIMIT = 2 × the session limit (1200/min), so a
 *       backup and a restore (or two jobs) can both run at full rate, while the
 *       total the device can drive through this path stays bounded no matter
 *       how many session ids it presents.
 *   - per org, across all its devices:
 *       AGENT_STORAGE_ORG_RATE_LIMIT (20,000/min) — the platform ceiling of the
 *       general per-org agent bucket (DEFAULT_AGENT_ORG_RATE_LIMIT_MAX). It
 *       bounds the load one tenant can drive through this path, including the
 *       tenant-status lookups that run after this gate, and is far above what
 *       an org's concurrent backups and restores need (~16 devices each at
 *       their full device ceiling).
 *
 * Refusals are free: a refused call is removed again from every window, so a
 * client that keeps retrying while throttled does not keep itself throttled,
 * and the Retry-After it is given is the time until the window actually has
 * room — not a flat second, which with punitive accounting became a retry loop
 * that never drained.
 *
 * Authentication and every authorization check on these routes are unchanged:
 * the agent credential is verified before this gate, and the session token,
 * device binding, scope and the session's own budget are checked by the route
 * handlers after it.
 */
export const AGENT_STORAGE_RATE_WINDOW_SECONDS = 60;
export const AGENT_STORAGE_SESSION_RATE_LIMIT = STORAGE_SESSION_CALLS_PER_MINUTE;
export const AGENT_STORAGE_DEVICE_RATE_LIMIT = 2 * AGENT_STORAGE_SESSION_RATE_LIMIT;
/** Equal to DEFAULT_AGENT_ORG_RATE_LIMIT_MAX (agentOrgRateLimit.ts); kept a literal so this module stays free of database imports. */
export const AGENT_STORAGE_ORG_RATE_LIMIT = 20_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Session ids are UUIDs; anything else is answered 404 by the route without a
 * lookup. Such calls share one bucket per device so the key stays bounded.
 */
const MALFORMED_SESSION_BUCKET = 'malformed';

export function agentStorageSessionRateKeys(
  orgId: string,
  deviceId: string,
  sessionId: string,
): { session: string; device: string; org: string } {
  const sessionBucket = UUID_PATTERN.test(sessionId) ? sessionId.toLowerCase() : MALFORMED_SESSION_BUCKET;
  return {
    session: `agent_storage_rate:session:${deviceId}:${sessionBucket}`,
    device: `agent_storage_rate:device:${deviceId}`,
    org: `agent_storage_rate:org:${orgId}`,
  };
}

export type AgentStorageRateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const failClosed = (): AgentStorageRateDecision => ({
  allowed: false,
  retryAfterSeconds: AGENT_STORAGE_RATE_WINDOW_SECONDS,
});

function numberAt(results: Array<[Error | null, unknown]>, index: number): number {
  const entry = results[index];
  if (!entry || entry[0]) throw entry?.[0] ?? new Error('missing pipeline result');
  const value = Number(entry[1]);
  if (!Number.isFinite(value)) throw new Error('non-numeric pipeline result');
  return value;
}

/**
 * Milliseconds until a full window holding `count` entries (this call's own
 * entry already removed) can admit one more: the (count - limit + 1)-th oldest
 * entry has to leave. Falls back to the whole window when the entry cannot be
 * read.
 */
async function msUntilRoom(redis: Redis, key: string, count: number, limit: number, windowMs: number, now: number): Promise<number> {
  const index = Math.max(0, count - limit);
  try {
    const entry = await redis.zrange(key, index, index, 'WITHSCORES');
    const score = Array.isArray(entry) && entry.length >= 2 ? Number(entry[1]) : NaN;
    if (!Number.isFinite(score)) return windowMs;
    return Math.max(0, score + windowMs - now);
  } catch {
    return windowMs;
  }
}

/**
 * Charge one storage-session call to its session, device and org windows, or
 * refuse it without charging any. Fails closed (refuses, advertising the full
 * window) when Redis is unavailable, like the general agent limiters.
 */
export async function checkAgentStorageSessionRateLimit(
  redis: Redis | null,
  input: { orgId: string; deviceId: string; sessionId: string },
  now: number = Date.now(),
): Promise<AgentStorageRateDecision> {
  if (!redis) {
    console.error('[agent-storage-rate] Redis unavailable, failing closed');
    return failClosed();
  }
  const windowMs = AGENT_STORAGE_RATE_WINDOW_SECONDS * 1000;
  const keys = agentStorageSessionRateKeys(input.orgId, input.deviceId, input.sessionId);
  // Session, then device, then org.
  const buckets = [
    { key: keys.session, limit: AGENT_STORAGE_SESSION_RATE_LIMIT },
    { key: keys.device, limit: AGENT_STORAGE_DEVICE_RATE_LIMIT },
    { key: keys.org, limit: AGENT_STORAGE_ORG_RATE_LIMIT },
  ];
  const member = `${now}-${Math.random().toString(36).slice(2, 12)}`;

  try {
    const pipeline = redis.multi();
    for (const b of buckets) pipeline.zremrangebyscore(b.key, '-inf', now - windowMs);
    for (const b of buckets) pipeline.zadd(b.key, now, member);
    for (const b of buckets) pipeline.zcard(b.key);
    for (const b of buckets) pipeline.pexpire(b.key, windowMs);
    const results = await pipeline.exec();
    if (!results) return failClosed();

    const counts = buckets.map((_, i) => numberAt(results, 2 * buckets.length + i));
    const over = buckets.map((b, i) => counts[i]! > b.limit);
    if (!over.some(Boolean)) return { allowed: true };

    // Refused: take this call back out of every window. If that fails the call
    // stays counted (the older, stricter behaviour) — never wrongly admitted.
    try {
      const refund = redis.multi();
      for (const b of buckets) refund.zrem(b.key, member);
      await refund.exec();
    } catch (err) {
      console.error('[agent-storage-rate] refund failed', err);
    }

    let waitMs = 0;
    for (let i = 0; i < buckets.length; i += 1) {
      if (!over[i]) continue;
      const b = buckets[i]!;
      waitMs = Math.max(waitMs, await msUntilRoom(redis, b.key, counts[i]! - 1, b.limit, windowMs, now));
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  } catch (err) {
    console.error('[agent-storage-rate] Redis error, failing closed', err);
    return failClosed();
  }
}
