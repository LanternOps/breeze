/**
 * Liveness marker for an install's credentials (#8318 §6.5).
 *
 * The reattach confirm (next PR) must prove the TARGET device is silent before
 * it hands the row to a new install. `devices.last_seen_at` covers agent
 * heartbeats and `watchdog_last_seen` covers watchdog beats, but the REST
 * command poll (`GET /agents/:id/commands`) claims work without touching
 * either, and a helper session never writes the row at all. So every
 * successful authentication — REST agent auth, helper auth and the WS
 * handshake — stamps `agent-cred-use:<deviceId>` in Redis with the time of
 * use, and the confirm reads the newest of all four signals.
 *
 * WHAT THE MARKER MEANS. It is keyed by `deviceId`, not by credential, and
 * every credential of the device writes it: the agent and the watchdog
 * (REST agent auth, middleware/agentAuth.ts, both roles), the helper
 * (middleware/helperAuth.ts) and the agent WS handshake (routes/agentWs.ts).
 * So it answers "did ANY credential of this device authenticate recently",
 * which is what the §6.5 liveness rule asks; it cannot tell which credential
 * or which install did. A reader that needs that must look elsewhere.
 *
 * Cost control: at most one Redis write per 30 s per device per process,
 * tracked in a bounded in-memory map (the watchdogRestartLogCache shape in
 * routes/agents/heartbeat.ts). The write is fire-and-forget and never throws
 * into the request. The reader distinguishes "no marker" from "Redis
 * unavailable" (with a `cause`) so the confirm can fail closed on the latter
 * and say why.
 *
 * Observability: `breeze_agent_credential_use_marker_writes_total{outcome}`
 * counts every write decision (`written`, `throttled`, `redis_unavailable`,
 * `error`), pre-seeded at 0. A Redis outage across a large fleet would
 * otherwise be one log line per device per 30 s; failures instead log at
 * most one warning per minute per process (write and read side each), with
 * the number suppressed since the last one.
 */
import { Counter } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';
import { getRedis } from './redis';

export const AGENT_CREDENTIAL_USE_KEY_PREFIX = 'agent-cred-use:';
/** How long a marker lives; the confirm's silence window (10 min) is far shorter. */
export const AGENT_CREDENTIAL_USE_TTL_SECONDS = 24 * 60 * 60;
/** Minimum spacing between writes for one device from one process. */
export const AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS = 30_000;
const RECENT_WRITES_MAX = 10_000;

const recentWrites = new Map<string, number>();

// ─── Metrics and rate-limited logging ─────────────────────────────────────

export type AgentCredentialUseWriteOutcome = 'written' | 'throttled' | 'redis_unavailable' | 'error';
export const AGENT_CREDENTIAL_USE_WRITES_METRIC = 'breeze_agent_credential_use_marker_writes_total';

const writesTotal: Counter<'outcome'> =
  (metricsRegistry.getSingleMetric(AGENT_CREDENTIAL_USE_WRITES_METRIC) as Counter<'outcome'> | undefined)
  ?? new Counter({
    name: AGENT_CREDENTIAL_USE_WRITES_METRIC,
    help: 'Agent credential-use liveness marker writes by outcome (#8318 §6.5); redis_unavailable/error mean the reattach confirm may see a live device as silent',
    labelNames: ['outcome'],
    registers: [metricsRegistry],
  });
// Pre-seed every series at 0 so rate()/alerts see a zero, not an absent series.
for (const outcome of ['written', 'throttled', 'redis_unavailable', 'error'] as const) writesTotal.inc({ outcome }, 0);

/** At most one warning per window per process for each side; the rest are counted and reported with the next one. */
export const AGENT_CREDENTIAL_USE_WARN_INTERVAL_MS = 60_000;

function rateLimitedWarner(label: string) {
  let lastAt = -Infinity;
  let suppressed = 0;
  return {
    warn(message: string, err: unknown, nowMs: number = Date.now()): void {
      if (nowMs - lastAt < AGENT_CREDENTIAL_USE_WARN_INTERVAL_MS) {
        suppressed += 1;
        return;
      }
      const extra = suppressed > 0 ? ` (${suppressed} more since the last warning)` : '';
      lastAt = nowMs;
      suppressed = 0;
      console.warn(`[agentCredentialUse] ${label}: ${message}${extra}`, err instanceof Error ? err.message : err ?? '');
    },
    reset(): void {
      lastAt = -Infinity;
      suppressed = 0;
    },
  };
}

const writeWarner = rateLimitedWarner('liveness marker not written');
const readWarner = rateLimitedWarner('liveness marker not read');

export function agentCredentialUseKey(deviceId: string): string {
  return `${AGENT_CREDENTIAL_USE_KEY_PREFIX}${deviceId}`;
}

function shouldWrite(deviceId: string, nowMs: number): boolean {
  const last = recentWrites.get(deviceId);
  if (last !== undefined && nowMs - last < AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS) return false;
  if (recentWrites.size >= RECENT_WRITES_MAX) {
    const cutoff = nowMs - AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS;
    for (const [key, at] of recentWrites) {
      if (at < cutoff) recentWrites.delete(key);
    }
    if (recentWrites.size >= RECENT_WRITES_MAX) {
      const oldest = recentWrites.keys().next().value;
      if (oldest !== undefined) recentWrites.delete(oldest);
    }
  }
  // Delete before set: `Map.set` on an existing key keeps its insertion slot,
  // and the cap eviction above takes the FIRST key, so a refreshed device must
  // move to the tail or it would be evicted ahead of entries written after it.
  recentWrites.delete(deviceId);
  recentWrites.set(deviceId, nowMs);
  return true;
}

/**
 * Record that one of the device's credentials just authenticated. Throttled,
 * fire-and-forget: a Redis failure is counted, logged (rate-limited) and the
 * request proceeds.
 */
export function recordAgentCredentialUse(deviceId: string, now: Date = new Date()): void {
  if (!shouldWrite(deviceId, now.getTime())) {
    writesTotal.inc({ outcome: 'throttled' });
    return;
  }
  let redis: ReturnType<typeof getRedis>;
  try {
    redis = getRedis();
  } catch (err) {
    writesTotal.inc({ outcome: 'redis_unavailable' });
    writeWarner.warn('Redis unavailable', err);
    return;
  }
  if (!redis) {
    writesTotal.inc({ outcome: 'redis_unavailable' });
    writeWarner.warn('Redis not configured', undefined);
    return;
  }
  Promise.resolve()
    .then(() => redis!.set(agentCredentialUseKey(deviceId), String(now.getTime()), 'EX', AGENT_CREDENTIAL_USE_TTL_SECONDS))
    .then(
      () => {
        writesTotal.inc({ outcome: 'written' });
      },
      (err: unknown) => {
        // Let the next request retry sooner than the throttle would.
        recentWrites.delete(deviceId);
        writesTotal.inc({ outcome: 'error' });
        writeWarner.warn('Redis write failed', err);
      },
    );
}

/** Why the marker could not be read: no Redis client, or the read itself failed. */
export type AgentCredentialUseUnavailableCause = 'redis_unavailable' | 'read_error';

export type AgentCredentialUse =
  | { at: Date | null }
  | { unavailable: true; cause: AgentCredentialUseUnavailableCause };

/**
 * When any of the device's credentials (agent, watchdog, helper — see the
 * module doc) last authenticated, as far as this marker knows: `{ at: null }`
 * when no marker exists (or it expired), and `{ unavailable: true, cause }`
 * when Redis could not answer — the confirm refuses with `liveness_unknown`
 * on that (fail closed) and can say why. Failures are logged, rate-limited.
 */
export async function readAgentCredentialUse(deviceId: string): Promise<AgentCredentialUse> {
  let redis: ReturnType<typeof getRedis>;
  try {
    redis = getRedis();
  } catch (err) {
    readWarner.warn('Redis unavailable', err);
    return { unavailable: true, cause: 'redis_unavailable' };
  }
  if (!redis) {
    readWarner.warn('Redis not configured', undefined);
    return { unavailable: true, cause: 'redis_unavailable' };
  }
  try {
    const raw = await redis.get(agentCredentialUseKey(deviceId));
    if (raw === null || raw === undefined || raw.trim() === '') return { at: null };
    // Only a positive epoch-ms is a use time. `Number('')` and `Number('0')`
    // are 0, a 1970 "use"; anything that is not a positive epoch-ms reads as
    // no marker, exactly like a missing key.
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) return { at: null };
    return { at: new Date(ms) };
  } catch (err) {
    readWarner.warn(`Redis read failed for device ${deviceId}`, err);
    return { unavailable: true, cause: 'read_error' };
  }
}

/** Test-only: forget every throttle entry and the warning rate limits. */
export function __resetAgentCredentialUseThrottleForTests(): void {
  recentWrites.clear();
  writeWarner.reset();
  readWarner.reset();
}

/** Test-only: how many devices the throttle currently tracks. */
export function agentCredentialUseThrottleSizeForTests(): number {
  return recentWrites.size;
}
