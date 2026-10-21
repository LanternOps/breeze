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
 * Cost control: at most one Redis write per 30 s per device per process,
 * tracked in a bounded in-memory map (the watchdogRestartLogCache shape in
 * routes/agents/heartbeat.ts). The write is fire-and-forget and never throws
 * into the request. The reader distinguishes "no marker" from "Redis
 * unavailable" so the confirm can fail closed on the latter.
 */
import { getRedis } from './redis';

export const AGENT_CREDENTIAL_USE_KEY_PREFIX = 'agent-cred-use:';
/** How long a marker lives; the confirm's silence window (10 min) is far shorter. */
export const AGENT_CREDENTIAL_USE_TTL_SECONDS = 24 * 60 * 60;
/** Minimum spacing between writes for one device from one process. */
export const AGENT_CREDENTIAL_USE_WRITE_INTERVAL_MS = 30_000;
const RECENT_WRITES_MAX = 10_000;

const recentWrites = new Map<string, number>();

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
  recentWrites.set(deviceId, nowMs);
  return true;
}

/**
 * Record that one of the device's credentials just authenticated. Throttled,
 * fire-and-forget: a Redis failure is logged and the request proceeds.
 */
export function recordAgentCredentialUse(deviceId: string, now: Date = new Date()): void {
  if (!shouldWrite(deviceId, now.getTime())) return;
  let redis: ReturnType<typeof getRedis>;
  try {
    redis = getRedis();
  } catch (err) {
    console.error('[agentCredentialUse] redis unavailable; liveness marker not written', err);
    return;
  }
  if (!redis) return;
  Promise.resolve()
    .then(() => redis!.set(agentCredentialUseKey(deviceId), String(now.getTime()), 'EX', AGENT_CREDENTIAL_USE_TTL_SECONDS))
    .catch((err) => {
      // Let the next request retry sooner than the throttle would.
      recentWrites.delete(deviceId);
      console.error(`[agentCredentialUse] failed to record credential use for device ${deviceId}:`, err);
    });
}

export type AgentCredentialUse = { at: Date | null } | { unavailable: true };

/**
 * When any of the device's credentials last authenticated, as far as this
 * marker knows: `{ at: null }` when no marker exists (or it expired), and
 * `{ unavailable: true }` when Redis could not answer — the confirm refuses
 * with `liveness_unknown` on that (fail closed).
 */
export async function readAgentCredentialUse(deviceId: string): Promise<AgentCredentialUse> {
  let redis: ReturnType<typeof getRedis>;
  try {
    redis = getRedis();
  } catch {
    return { unavailable: true };
  }
  if (!redis) return { unavailable: true };
  try {
    const raw = await redis.get(agentCredentialUseKey(deviceId));
    if (raw === null || raw === undefined) return { at: null };
    const ms = Number(raw);
    if (!Number.isFinite(ms)) return { at: null };
    return { at: new Date(ms) };
  } catch {
    return { unavailable: true };
  }
}

/** Test-only: forget every throttle entry. */
export function __resetAgentCredentialUseThrottleForTests(): void {
  recentWrites.clear();
}

/** Test-only: how many devices the throttle currently tracks. */
export function agentCredentialUseThrottleSizeForTests(): number {
  return recentWrites.size;
}
