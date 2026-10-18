// Connection health liveness (spec §8, W4 plan D11). The reconciler writes a
// heartbeat after each scheduled run and per-kind last success / failure
// streaks; the digest writes its own heartbeat after each run (a dead digest
// was otherwise visible only in BullMQ). /admin/system reads them through
// readConnectionHealthJobStatus(). Redis only: a status read never touches the
// database, and a Redis failure is reported, never thrown.

export const RECONCILE_HEARTBEAT_KEY = 'connection-health:reconcile:heartbeat';
export const RECONCILE_HEARTBEAT_TTL_S = 3600;
/** Two missed 15-minute ticks plus slack. */
export const RECONCILE_STALE_AFTER_MS = 35 * 60_000;

export const DIGEST_HEARTBEAT_KEY = 'connection-health:digest:heartbeat';
/** Long enough that a stopped digest shows as stale for hours before the key expires. */
export const DIGEST_HEARTBEAT_TTL_S = 6 * 3600;
/** The digest runs hourly: two missed runs plus slack. */
export const DIGEST_STALE_AFTER_MS = 150 * 60_000;

export type KindStateField = 'last-ok' | 'seeded' | 'failures';
export const kindStateKey = (kind: string, field: KindStateField) => `connection-health:kind:${kind}:${field}`;

export type HeartbeatState = 'ok' | 'stale' | 'missing';
export type KindJobState = HeartbeatState | 'failing';

export type ConnectionHealthJobStatus = {
  redis: 'ok' | 'unavailable';
  reconcile: { lastRunAt: string | null; state: HeartbeatState };
  digest: { lastRunAt: string | null; state: HeartbeatState };
  kinds: Array<{ kind: string; intervalMinutes: number; lastOkAt: string | null; failureStreak: number; state: KindJobState }>;
};

/** The two Redis calls this module makes; an ioredis client satisfies it. */
export type HeartbeatRedis = {
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
};

function heartbeat(raw: string | null, staleAfterMs: number, now: Date): { lastRunAt: string | null; state: HeartbeatState } {
  const at = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) return { lastRunAt: null, state: 'missing' };
  return { lastRunAt: new Date(at).toISOString(), state: now.getTime() - at > staleAfterMs ? 'stale' : 'ok' };
}

export async function readConnectionHealthJobStatus(
  redis: HeartbeatRedis | null,
  kinds: ReadonlyArray<{ kind: string; intervalMinutes: number }>,
  now: Date,
): Promise<ConnectionHealthJobStatus> {
  const keys = [
    RECONCILE_HEARTBEAT_KEY,
    DIGEST_HEARTBEAT_KEY,
    ...kinds.flatMap((k) => [kindStateKey(k.kind, 'last-ok'), kindStateKey(k.kind, 'failures')]),
  ];
  let values: Array<string | null> = keys.map(() => null);
  let available = redis !== null;
  if (redis) {
    try {
      values = await redis.mget(...keys);
    } catch (err) {
      available = false;
      console.warn(JSON.stringify({
        event: 'connection_health_status_read_failed',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      }));
    }
  }
  return {
    redis: available ? 'ok' : 'unavailable',
    reconcile: heartbeat(values[0] ?? null, RECONCILE_STALE_AFTER_MS, now),
    digest: heartbeat(values[1] ?? null, DIGEST_STALE_AFTER_MS, now),
    kinds: kinds.map((k, i) => {
      const lastOk = Number(values[2 + i * 2] ?? 0);
      const streak = Number(values[3 + i * 2] ?? 0);
      const failureStreak = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0;
      const lastOkAt = Number.isFinite(lastOk) && lastOk > 0 ? new Date(lastOk).toISOString() : null;
      let state: KindJobState;
      if (failureStreak > 0) state = 'failing';
      else if (lastOkAt === null) state = 'missing';
      else state = now.getTime() - lastOk > (3 * k.intervalMinutes + 5) * 60_000 ? 'stale' : 'ok';
      return { kind: k.kind, intervalMinutes: k.intervalMinutes, lastOkAt, failureStreak, state };
    }),
  };
}

/** Never throws: a heartbeat must not fail the digest job it reports on. */
export async function writeDigestHeartbeat(redis: Pick<HeartbeatRedis, 'set'> | null, at: Date): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(DIGEST_HEARTBEAT_KEY, at.toISOString(), 'EX', DIGEST_HEARTBEAT_TTL_S);
  } catch (err) {
    console.warn(JSON.stringify({
      event: 'connection_health_digest_heartbeat_failed',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    }));
  }
}
