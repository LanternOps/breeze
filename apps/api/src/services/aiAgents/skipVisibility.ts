/**
 * #5381 — AI agent run skips must never be invisible.
 *
 * Before this module, a declined trigger left three different traces
 * depending on where it was declined:
 *
 *   - `runService.ts`'s `skip()` logged at `console.info` (invisible at the
 *     default log level a container is read at) and published an
 *     observability event for only 11 of the ~25 reasons.
 *   - `alertVerdictSubscriber.ts`'s three `if (!AI_AGENTS_ENABLED) return`
 *     short-circuits logged NOTHING at all — the case that actually bit on US
 *     prod on 2026-09-09, where every alert trigger was dropped for hours and
 *     finding out took a DB query plus a container `env` dump.
 *   - Nothing anywhere was readable by the web app, so Settings → AI Agents
 *     happily showed "Running" (#5380).
 *
 * This module is the one path all of them now go through. It does two things,
 * neither of which may ever throw into a caller:
 *
 *  1. **Log** one `console.warn` line per skip, rate-limited per
 *     `(orgId, reason)` so a busy alert stream cannot flood the log. A
 *     throttled line carries `suppressedSinceLastLog` so the count is never
 *     lost, only batched.
 *  2. **Count** the skip in Redis, keyed per org and reason, so the settings
 *     page can render "N triggers skipped recently: kill_switch_off". Redis
 *     (not Postgres) deliberately: a skip counter is operational telemetry
 *     with a natural expiry, not tenant data — putting it in Postgres would
 *     mean a new tenant-scoped table with RLS policies, a cascade-list entry
 *     and an export-policy classification for something that is allowed to
 *     be lost on a Redis flush. The counters are also written from the worker
 *     process and read from the API process, so an in-process counter would
 *     read empty exactly where it matters.
 *
 * RETENTION is a sliding 48h from the LAST skip for that org, not a fixed
 * window: the key's TTL is refreshed on every write. The summary therefore
 * reports `firstAt` alongside the count rather than claiming a "last 24h"
 * precision it does not have.
 */
import { getRedis } from '../redis';

/** Everything a skip is allowed to say about itself. Only `orgId` and
 *  `reason` are required — the early returns in `alertVerdictSubscriber.ts`
 *  fire before an agent has even been resolved. */
export interface AgentRunSkipRecord {
  orgId: string;
  reason: string;
  agentId?: string | null;
  kind?: string | null;
  triggerKind?: string | null;
  deviceId?: string | null;
  alertId?: string | null;
  dedupeKey?: string | null;
}

export interface AgentRunSkipReasonSummary {
  reason: string;
  count: number;
  /** ISO of the oldest skip still counted (the key's TTL bounds this). */
  firstAt: string | null;
  lastAt: string | null;
}

export interface AgentRunSkipSummary {
  /** How long a counter survives with no further skips for that org. */
  retentionHours: number;
  total: number;
  /** Highest count first; ties broken by most recent. */
  reasons: AgentRunSkipReasonSummary[];
}

const REDIS_KEY_PREFIX = 'breeze:ai-agents:skips:';
const RETENTION_HOURS = 48;
const RETENTION_SECONDS = RETENTION_HOURS * 3600;
const WARN_THROTTLE_MS = 60_000;
/** Bound on the throttle map: a pathological org/reason fan-out must not
 *  turn an observability helper into a leak. Oldest entries are dropped. */
const THROTTLE_MAX_ENTRIES = 500;
/** A partner-scoped caller can reach thousands of orgs; the summary is a
 *  banner line, not an analytics surface. */
const SKIP_SUMMARY_ORG_LIMIT = 25;

const throttle = new Map<string, { lastLoggedAt: number; suppressed: number }>();

function shouldLog(key: string, now: number): { log: boolean; suppressed: number } {
  const entry = throttle.get(key);
  if (entry && now - entry.lastLoggedAt < WARN_THROTTLE_MS) {
    entry.suppressed += 1;
    return { log: false, suppressed: entry.suppressed };
  }
  const suppressed = entry?.suppressed ?? 0;
  if (throttle.size >= THROTTLE_MAX_ENTRIES && !entry) {
    const oldest = throttle.keys().next();
    if (!oldest.done) throttle.delete(oldest.value);
  }
  throttle.set(key, { lastLoggedAt: now, suppressed: 0 });
  return { log: true, suppressed };
}

async function countSkip(orgId: string, reason: string, now: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = `${REDIS_KEY_PREFIX}${orgId}`;
  const results = await redis
    .multi()
    .hincrby(key, `count:${reason}`, 1)
    .hsetnx(key, `first:${reason}`, String(now))
    .hset(key, `last:${reason}`, String(now))
    .expire(key, RETENTION_SECONDS)
    .exec();

  // ioredis RESOLVES a pipeline with one [error, result] tuple per command;
  // only a connection-level failure rejects. So `OOM command not allowed when
  // used memory > 'maxmemory'`, a WRONGTYPE on the key, or an ACL denial
  // arrives HERE, not in the caller's `.catch` — and a Redis under memory
  // pressure is exactly the incident this counter exists to make visible.
  // Left unchecked, the counter would silently stop moving while
  // `readAgentRunSkipSummary` kept returning a summary that looked complete.
  const failure = results?.find(([error]) => error != null)?.[0];
  if (failure) {
    console.error('[aiAgents] run-skip counter write failed', { orgId, reason, error: failure });
  }
}

/**
 * Records one declined trigger. Fire-and-forget by design — a skip is already
 * a non-event for the caller, and observability must never turn it into a
 * throw (the same posture `runService.ts` takes around `publishEvent`).
 */
export function recordAgentRunSkip(entry: AgentRunSkipRecord): void {
  const now = Date.now();
  const { log, suppressed } = shouldLog(`${entry.orgId}::${entry.reason}`, now);
  if (log) {
    console.warn('[aiAgents] run skipped', {
      reason: entry.reason,
      orgId: entry.orgId,
      agentId: entry.agentId ?? null,
      kind: entry.kind ?? null,
      triggerKind: entry.triggerKind ?? null,
      deviceId: entry.deviceId ?? null,
      alertId: entry.alertId ?? null,
      dedupeKey: entry.dedupeKey ?? null,
      // 0 on the first line for a reason; >0 means this line stands in for
      // that many throttled repeats since the previous one.
      suppressedSinceLastLog: suppressed,
    });
  }
  void countSkip(entry.orgId, entry.reason, now).catch((error: unknown) => {
    console.error('[aiAgents] failed to count run skip', { orgId: entry.orgId, reason: entry.reason, error });
  });
}

function toIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Aggregated skip counters for the orgs a caller can see.
 *
 * Returns `null` — never an empty summary — whenever the answer is UNKNOWN
 * (no Redis, no orgs in scope, a failed read). A zero would read on the page
 * as "nothing was dropped", which is exactly the false reassurance #5381 is
 * about.
 */
export async function readAgentRunSkipSummary(orgIds: string[]): Promise<AgentRunSkipSummary | null> {
  if (orgIds.length === 0) return null;
  const redis = getRedis();
  if (!redis) return null;

  const scoped = orgIds.slice(0, SKIP_SUMMARY_ORG_LIMIT);
  try {
    const hashes = await Promise.all(
      scoped.map((orgId) => redis.hgetall(`${REDIS_KEY_PREFIX}${orgId}`)),
    );
    const byReason = new Map<string, { count: number; firstMs: number | null; lastMs: number | null }>();
    for (const hash of hashes) {
      for (const [field, value] of Object.entries(hash ?? {})) {
        const [prefix, ...rest] = field.split(':');
        const reason = rest.join(':');
        if (!reason) continue;
        const current = byReason.get(reason) ?? { count: 0, firstMs: null, lastMs: null };
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) continue;
        if (prefix === 'count') current.count += numeric;
        else if (prefix === 'first') current.firstMs = current.firstMs === null ? numeric : Math.min(current.firstMs, numeric);
        else if (prefix === 'last') current.lastMs = current.lastMs === null ? numeric : Math.max(current.lastMs, numeric);
        byReason.set(reason, current);
      }
    }

    const reasons = [...byReason.entries()]
      .filter(([, v]) => v.count > 0)
      .map(([reason, v]) => ({
        reason,
        count: v.count,
        firstAt: toIso(v.firstMs === null ? undefined : String(v.firstMs)),
        lastAt: toIso(v.lastMs === null ? undefined : String(v.lastMs)),
      }))
      .sort((a, b) => b.count - a.count || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

    return {
      retentionHours: RETENTION_HOURS,
      total: reasons.reduce((sum, r) => sum + r.count, 0),
      reasons,
    };
  } catch (error) {
    console.error('[aiAgents] failed to read run-skip summary', { error });
    return null;
  }
}

/** Test seam — clears the log-throttle state between cases. */
export function _resetSkipVisibilityForTest(): void {
  throttle.clear();
}
