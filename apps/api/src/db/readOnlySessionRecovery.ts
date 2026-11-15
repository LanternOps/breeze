import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, withSystemDbAccessContext } from './index';
import { notePoolReadOnly, notePoolWritable } from './readOnlyDatabase';
import { resolveRequestDatabaseConfig } from './requestDatabaseConfig';

/**
 * #11741 item 3: recycle pooled sessions that kept a read-only default after
 * the database became writable again.
 *
 * `default_transaction_read_only` set at database or role level (`ALTER
 * DATABASE ... SET`, which is how a provider flips a full disk to read-only)
 * applies when a session STARTS. A connection the request pool opened while
 * the database was read-only keeps that default after the provider makes the
 * database writable, until postgres.js retires it (`max_lifetime`, 30 min; a
 * busy pool never hits `idle_timeout`). Until then writes on it keep failing
 * with SQLSTATE 25006, `/health/ready` keeps reporting `db-read-only`, and
 * deferred startup writes keep waiting.
 *
 * The monitor, one per process:
 *   1. watching: every tick, ask a pooled session whether it is read-only.
 *      That is one `select` per tick and the only steady-state cost.
 *   2. read-only: a pooled session said yes. Each tick asks a FRESH session
 *      (one short-lived side connection, outside the pool) the same question.
 *      While it says read-only too, the database really is, and nothing
 *      happens. After `freshProbeBackoffAfterMs` (30 min) the fresh check
 *      drops to every `freshProbeBackoffEvery`th tick (5 min), so a database
 *      that is read-only on purpose (a standby) costs one side connection per
 *      process every 5 minutes, not every 30 seconds.
 *   3. recovering: a fresh session says writable, so pooled sessions older than
 *      that moment may be stale. Each tick terminates the IDLE ones and
 *      re-counts. postgres.js reconnects a terminated idle connection on its
 *      next use, so the pool refills with sessions that read the current
 *      default. Busy ones are left alone and caught by a later pass once they
 *      go idle. Done when none is left, or after `maxRecoveryMs` (by then
 *      `max_lifetime` has retired every one of them anyway).
 *
 * The termination predicate is deliberately narrow: same role
 * (`usename = current_user`, which is also what makes `pg_terminate_backend`
 * need no extra privilege), same database, client backends only, the request
 * pool's own `application_name` (read from the pooled session, so it cannot
 * drift from db/index.ts), `state = 'idle'`, and `backend_start` before the
 * moment a fresh session first saw the database writable (the database's
 * clock, not ours). It can include the other API process's pool (api and worker
 * share the role and the application name). Their sessions are equally old, so
 * equally likely stale, and they reconnect the same way.
 *
 * The monitor also drives the process-wide "pool observed read-only" flag
 * (readOnlyDatabase.ts) that gates the read-only log throttle: set when a
 * pooled session reads read-only, kept through recovery (stale sessions keep
 * failing), cleared when recovery ends or a watching tick reads writable.
 *
 * The one cost: a session that the pool hands out between the snapshot and the
 * signal fails that one statement (SQLSTATE 57P01). This happens once per
 * read-only episode, while writes on stale sessions are failing anyway.
 */

export const READ_ONLY_SESSION_RECOVERY_INTERVAL_MS = 30_000;
/** Longer than the request pool's `max_lifetime` (30 min, db/index.ts). */
export const READ_ONLY_SESSION_RECOVERY_MAX_MS = 35 * 60_000;
export const READ_ONLY_SESSION_RECOVERY_APPLICATION_NAME = 'breeze-read-only-session-recovery';
const FRESH_PROBE_BACKOFF_AFTER_MS = 30 * 60_000;
const FRESH_PROBE_BACKOFF_EVERY = 10;
/** A persistent failure is re-logged every this many consecutive failed ticks (10 min). */
const FAILURE_REMINDER_EVERY = 20;

export interface PoolProbeResult {
  readOnly: boolean;
  /** The request pool's `application_name`, the termination predicate's key. */
  applicationName: string;
}

export interface FreshProbeResult {
  readOnly: boolean;
  /** The database's clock when the fresh session answered (timestamptz text). */
  checkedAt: string;
}

export interface RecyclePassResult {
  /** Idle sessions signalled this pass. */
  terminated: number;
  /** Matching sessions (idle or not) still open after the pass. */
  remaining: number;
}

export interface ReadOnlySessionRecoveryDeps {
  probePool(): Promise<PoolProbeResult>;
  probeFreshSession(): Promise<FreshProbeResult>;
  recycleSessionsOpenedBefore(applicationName: string, cutoff: string): Promise<RecyclePassResult>;
  now(): number;
}

export type ReadOnlySessionRecoveryState = 'watching' | 'read-only' | 'recovering';

export interface ReadOnlySessionRecovery {
  tick(): Promise<void>;
  state(): ReadOnlySessionRecoveryState;
}

export function createReadOnlySessionRecovery(
  deps: ReadOnlySessionRecoveryDeps,
  options: {
    maxRecoveryMs?: number;
    freshProbeBackoffAfterMs?: number;
    freshProbeBackoffEvery?: number;
  } = {},
): ReadOnlySessionRecovery {
  const maxRecoveryMs = options.maxRecoveryMs ?? READ_ONLY_SESSION_RECOVERY_MAX_MS;
  const backoffAfterMs = options.freshProbeBackoffAfterMs ?? FRESH_PROBE_BACKOFF_AFTER_MS;
  const backoffEvery = options.freshProbeBackoffEvery ?? FRESH_PROBE_BACKOFF_EVERY;
  let state: ReadOnlySessionRecoveryState = 'watching';
  let applicationName = '';
  let cutoff = '';
  let readOnlySince = 0;
  let readOnlyTicks = 0;
  let recoveryStartedAt = 0;
  let terminatedTotal = 0;
  let running = false;
  let lastFailure: string | null = null;
  let consecutiveFailures = 0;

  const recoveryExpired = (): boolean =>
    state === 'recovering' && deps.now() - recoveryStartedAt >= maxRecoveryMs;

  const recyclePass = async (): Promise<void> => {
    const pass = await deps.recycleSessionsOpenedBefore(applicationName, cutoff);
    terminatedTotal += pass.terminated;
    if (pass.remaining === 0) {
      console.log(
        `[db-read-only-recovery] every pooled session opened while the database was read-only is ` +
          `recycled (${terminatedTotal} terminated).`,
      );
      state = 'watching';
      notePoolWritable();
    } else if (recoveryExpired()) {
      console.warn(
        `[db-read-only-recovery] ${pass.remaining} session(s) opened before the database became ` +
          'writable are still busy; leaving them to the pool\'s max_lifetime.',
      );
      state = 'watching';
      notePoolWritable();
    }
  };

  const step = async (): Promise<void> => {
    if (state === 'watching') {
      const pool = await deps.probePool();
      if (!pool.readOnly) {
        notePoolWritable();
        return;
      }
      applicationName = pool.applicationName;
      state = 'read-only';
      notePoolReadOnly();
      readOnlySince = deps.now();
      readOnlyTicks = 0;
      console.warn(
        '[db-read-only-recovery] a pooled database session is read-only; checking a fresh session ' +
          `every ${READ_ONLY_SESSION_RECOVERY_INTERVAL_MS / 1000}s to recycle the pool once the ` +
          'database accepts writes again.',
      );
      return;
    }
    if (state === 'read-only') {
      readOnlyTicks += 1;
      if (deps.now() - readOnlySince >= backoffAfterMs && readOnlyTicks % backoffEvery !== 0) return;
      const fresh = await deps.probeFreshSession();
      if (fresh.readOnly) return;
      cutoff = fresh.checkedAt;
      recoveryStartedAt = deps.now();
      terminatedTotal = 0;
      state = 'recovering';
      console.warn(
        '[db-read-only-recovery] a fresh session accepts writes again; recycling idle pooled ' +
          `sessions opened before ${cutoff}.`,
      );
    }
    await recyclePass();
  };

  return {
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        await step();
        lastFailure = null;
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        // A new failure is logged at once; the same one again only every
        // FAILURE_REMINDER_EVERY ticks. When the database is down this would
        // otherwise repeat every 30 s next to the louder connection errors,
        // and a permanent fault (a privilege the recycle query lacks) must
        // still stay visible.
        if (message !== lastFailure || consecutiveFailures % FAILURE_REMINDER_EVERY === 0) {
          console.warn(
            `[db-read-only-recovery] check failed (state ${state}, ${consecutiveFailures} in a row): ${message}`,
          );
          lastFailure = message;
        }
        // The recovery window also ends when every pass fails.
        if (recoveryExpired()) {
          console.warn('[db-read-only-recovery] giving up on recycling; the pool\'s max_lifetime retires the rest.');
          state = 'watching';
          notePoolWritable();
        }
      } finally {
        running = false;
      }
    },
    state: () => state,
  };
}

// ---------------------------------------------------------------------------
// Production dependencies.
// ---------------------------------------------------------------------------

function firstRow<T>(result: unknown): T | undefined {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows[0] as T | undefined) : undefined;
}

/** Exported for tests. */
export async function probeRequestPool(): Promise<PoolProbeResult> {
  const row = await withSystemDbAccessContext(async () =>
    firstRow<{ ro?: unknown; app?: unknown }>(
      await db.execute(sql`select current_setting('transaction_read_only') as ro, current_setting('application_name') as app`),
    ),
  );
  if (typeof row?.ro !== 'string' || typeof row.app !== 'string') {
    throw new Error('pooled read-only probe returned an unexpected result shape');
  }
  return { readOnly: row.ro === 'on', applicationName: row.app };
}

/**
 * One short-lived connection as the request pool's role, never the pool
 * itself: the pool is what is under suspicion. `timeout: 0` destroys rather
 * than drains on close.
 */
async function withFreshSession<T>(url: string, fn: (session: postgres.Sql) => Promise<T>): Promise<T> {
  const session = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    max_lifetime: 30,
    onnotice: () => {},
    connection: { application_name: READ_ONLY_SESSION_RECOVERY_APPLICATION_NAME },
  });
  try {
    return await fn(session);
  } finally {
    await session.end({ timeout: 0 }).catch((error: unknown) => {
      console.warn('[db-read-only-recovery] fresh session end() failed; the connection may be leaked:', error);
    });
  }
}

/** Exported for the integration test, which points it at a scratch database. */
export async function probeFreshSessionAt(url: string): Promise<FreshProbeResult> {
  return withFreshSession(url, async (session) => {
    const [row] = await session<{ ro: string; checkedAt: string }[]>`
      select current_setting('transaction_read_only') as ro, clock_timestamp()::text as "checkedAt"
    `;
    if (!row) throw new Error('fresh read-only probe returned no row');
    return { readOnly: row.ro === 'on', checkedAt: row.checkedAt };
  });
}

/** Exported for the integration test, which points it at a scratch database. */
export async function recycleSessionsOpenedBeforeAt(
  url: string,
  applicationName: string,
  cutoff: string,
): Promise<RecyclePassResult> {
  return withFreshSession(url, async (session) => {
    const [row] = await session<{ terminated: number; remaining: number }[]>`
      with candidates as (
        select pid, state
        from pg_stat_activity
        where usename = current_user
          and datname = current_database()
          and backend_type = 'client backend'
          and pid <> pg_backend_pid()
          and application_name = ${applicationName}
          and backend_start < ${cutoff}::timestamptz
      ),
      signalled as (
        -- CASE, not AND: SQL does not promise left-to-right evaluation, and
        -- a busy session must never be signalled.
        select pid from candidates
        where case when state = 'idle' then pg_terminate_backend(pid) else false end
      )
      select
        (select count(*) from signalled)::int as terminated,
        ((select count(*) from candidates) - (select count(*) from signalled))::int as remaining
    `;
    return { terminated: row?.terminated ?? 0, remaining: row?.remaining ?? 0 };
  });
}

let timer: NodeJS.Timeout | null = null;

/** Starts the per-process monitor. Idempotent; returns the interval in ms. */
export function startReadOnlySessionRecovery(): number {
  if (timer) return READ_ONLY_SESSION_RECOVERY_INTERVAL_MS;
  const url = resolveRequestDatabaseConfig().url;
  const recovery = createReadOnlySessionRecovery({
    probePool: probeRequestPool,
    probeFreshSession: () => probeFreshSessionAt(url),
    recycleSessionsOpenedBefore: (applicationName, cutoff) =>
      recycleSessionsOpenedBeforeAt(url, applicationName, cutoff),
    now: Date.now,
  });
  timer = setInterval(() => {
    void recovery.tick();
  }, READ_ONLY_SESSION_RECOVERY_INTERVAL_MS);
  timer.unref?.();
  return READ_ONLY_SESSION_RECOVERY_INTERVAL_MS;
}

export function stopReadOnlySessionRecovery(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
