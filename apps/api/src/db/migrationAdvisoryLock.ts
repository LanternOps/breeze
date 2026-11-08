import type postgres from 'postgres';

/**
 * Bounded session advisory lock for the two migration runners: the core run
 * (`autoMigrate.ts`, one lock for the whole run) and the per-extension run
 * (`extensions/migrator.ts`, one lock per extension).
 *
 * Both used to take the lock with a blocking `pg_advisory_lock`, which waits
 * for as long as the holder keeps it. A migrator that wedged while holding it
 * (a stuck `db:migrate` in an operator's shell, an orphaned backend that TCP
 * keepalive has not reaped yet) therefore stalled every later boot forever,
 * with nothing in the logs saying why (#4144 item 5).
 *
 * This takes the lock with the non-blocking `pg_try_advisory_lock` instead,
 * polling until a total deadline. While it waits it logs which backend holds
 * the lock, and at the deadline it throws {@link MigrationLockTimeoutError}.
 * Both callers let that error abort startup, which exits the process non-zero,
 * and the container restart policy (`restart: unless-stopped`) starts a fresh
 * attempt. The lock itself is unchanged: same key, same session scope, same
 * `pg_advisory_unlock`. It still has to be taken on the connection that runs
 * the migrations, because a session advisory lock belongs to one backend.
 *
 * Polling gives up the fair FIFO queue a blocking wait has. Only a handful of
 * processes ever migrate one database at once, so that queue bought nothing,
 * and polling is what lets the wait report its holder while it runs.
 */

/** The environment variable that sets the total wait, in milliseconds. */
export const MIGRATION_LOCK_TIMEOUT_ENV = 'MIGRATION_LOCK_TIMEOUT_MS';

/**
 * Five minutes. Long enough that a second replica booting during a rolling
 * deploy outwaits an ordinary migration run; short enough that a wedged holder
 * shows up in the logs instead of looking like a slow boot. A run that
 * legitimately holds the lock longer (a large index build) costs the waiter a
 * restart per interval, not a failure: each restart tries again, and once the
 * holder finishes the waiter finds nothing pending.
 */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_PROGRESS_LOG_INTERVAL_MS = 30_000;

/**
 * Read {@link MIGRATION_LOCK_TIMEOUT_ENV}. Unset or empty means the default,
 * because the compose files pass every variable as `${VAR:-}`, which reaches
 * the container as an empty string, not as an absent one.
 *
 * Any other value must be a plain positive whole number of milliseconds. A
 * value like `10m` or `5e3` throws instead of falling back. Falling back would
 * quietly wait some other amount of time than the operator asked for. The
 * throw happens before any database work, so the boot log names the bad value.
 */
export function resolveMigrationLockTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[MIGRATION_LOCK_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${MIGRATION_LOCK_TIMEOUT_ENV} must be a positive whole number of milliseconds ` +
        `(e.g. 600000 for ten minutes); got ${JSON.stringify(env[MIGRATION_LOCK_TIMEOUT_ENV])}`,
    );
  }
  return parsed;
}

/** The backend holding the lock, as far as `pg_stat_activity` shows it. */
export interface MigrationLockHolder {
  pid: number;
  applicationName: string | null;
  clientAddr: string | null;
  state: string | null;
  backendStart: string | null;
}

/** Thrown when the lock is still held by another session at the deadline. */
export class MigrationLockTimeoutError extends Error {
  readonly lockKey: string;
  readonly timeoutMs: number;
  /** Null when the holder could not be identified. */
  readonly holderPid: number | null;

  constructor(message: string, lockKey: string, timeoutMs: number, holderPid: number | null) {
    super(message);
    this.name = 'MigrationLockTimeoutError';
    this.lockKey = lockKey;
    this.timeoutMs = timeoutMs;
    this.holderPid = holderPid;
  }
}

/** Caller-tunable parts of the wait. Production callers pass none of these. */
export interface MigrationLockWaitOptions {
  /** Total wait. Defaults to {@link resolveMigrationLockTimeoutMs}. */
  timeoutMs?: number;
  /** Gap between attempts. Default 2s. */
  pollIntervalMs?: number;
  /** Minimum gap between repeated "still waiting" lines. Default 30s. */
  progressLogIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  /**
   * Test seams: a fake clock instead of real time. The default clock is
   * monotonic (`performance.now`), so a wall-clock step during the wait can
   * neither cut the deadline short nor stretch it.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AcquireMigrationLockOptions extends MigrationLockWaitOptions {
  /** Log prefix that names the caller, e.g. `[auto-migrate]`. */
  label: string;
}

type HolderLookup =
  | { kind: 'found'; holder: MigrationLockHolder }
  | { kind: 'none' }
  | { kind: 'failed'; reason: string };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function assertPositiveMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`acquireMigrationAdvisoryLock: ${name} must be a positive whole number of ms (got ${value})`);
  }
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which backend holds the advisory lock for `key`.
 *
 * A lock taken with a bigint key shows in `pg_locks` with `classid` = the high
 * 32 bits of the key, `objid` = the low 32 bits, and `objsubid` = 1. The key is
 * recomputed here with the same `hashtextextended(key, 0)` the lock call uses.
 * Only `pg_stat_activity` fields that carry no SQL text are read, so no query
 * text from the holder ends up in the logs.
 */
async function lookUpHolder(conn: postgres.Sql, key: string): Promise<HolderLookup> {
  try {
    const rows = await conn`
      WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
      SELECT a.pid, a.application_name, host(a.client_addr) AS client_addr,
             a.state, a.backend_start::text AS backend_start
      FROM k, pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory'
        AND l.granted
        AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid = ((k.v >> 32) & 4294967295)::oid
        AND l.objid = (k.v & 4294967295)::oid
      LIMIT 1`;
    const row = rows[0] as
      | { pid: unknown; application_name: unknown; client_addr: unknown; state: unknown; backend_start: unknown }
      | undefined;
    if (!row) return { kind: 'none' };
    const text = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
    return {
      kind: 'found',
      holder: {
        pid: Number(row.pid),
        applicationName: text(row.application_name),
        clientAddr: text(row.client_addr),
        state: text(row.state),
        backendStart: text(row.backend_start),
      },
    };
  } catch (error) {
    // The lookup is diagnostics only and must never decide the outcome of the
    // wait. Its failure is reported in the log line and in the timeout error.
    return { kind: 'failed', reason: describeError(error) };
  }
}

function describeHolder(lookup: HolderLookup): string {
  if (lookup.kind === 'none') {
    return 'no holder found (it may have just released the lock)';
  }
  if (lookup.kind === 'failed') {
    return `the holder could not be identified (${lookup.reason})`;
  }
  const { holder } = lookup;
  const details = [
    `application_name=${JSON.stringify(holder.applicationName ?? '')}`,
    `client_addr=${holder.clientAddr ?? 'local'}`,
    `state=${holder.state ?? 'unknown'}`,
    `backend_start=${holder.backendStart ?? 'unknown'}`,
  ].join(', ');
  return `held by backend pid ${holder.pid} (${details})`;
}

/** One non-blocking attempt. True = this session now holds the lock. */
async function tryLock(conn: postgres.Sql, key: string): Promise<boolean> {
  const rows = await conn`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`;
  const locked = (rows[0] as { locked?: unknown } | undefined)?.locked;
  if (typeof locked !== 'boolean') {
    // Reading a malformed answer as "not acquired" would retry it until the
    // deadline and then blame a holder that may not exist.
    throw new Error(`pg_try_advisory_lock returned an unexpected result: ${JSON.stringify(rows[0] ?? null)}`);
  }
  return locked;
}

/**
 * Take the session advisory lock for `key` on `conn`, waiting at most the
 * configured deadline. Resolves once the lock is held. Rejects with
 * {@link MigrationLockTimeoutError} when another session still holds it at the
 * deadline. A query error (for example a dropped connection) propagates as is
 * and is not retried.
 *
 * `conn` must be the connection that runs the migrations. See the module
 * comment.
 */
export async function acquireMigrationAdvisoryLock(
  conn: postgres.Sql,
  key: string,
  options: AcquireMigrationLockOptions,
): Promise<void> {
  // Validate everything before the first query, so a bad setting fails the
  // boot without touching the database.
  const timeoutMs = options.timeoutMs ?? resolveMigrationLockTimeoutMs();
  assertPositiveMs(timeoutMs, 'timeoutMs');
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  assertPositiveMs(pollIntervalMs, 'pollIntervalMs');
  const progressLogIntervalMs = options.progressLogIntervalMs ?? DEFAULT_PROGRESS_LOG_INTERVAL_MS;
  assertPositiveMs(progressLogIntervalMs, 'progressLogIntervalMs');
  const logger = options.logger ?? console;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? realSleep;
  const { label } = options;

  const startedAt = now();
  let lastProgressLogAt: number | null = null;

  for (;;) {
    if (await tryLock(conn, key)) {
      if (lastProgressLogAt !== null) {
        logger.log(`${label} Migration lock "${key}" acquired after ${formatSeconds(now() - startedAt)}`);
      }
      return;
    }

    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      const lookup = await lookUpHolder(conn, key);
      const holderPid = lookup.kind === 'found' ? lookup.holder.pid : null;
      const remedy =
        holderPid !== null
          ? `Check it with SELECT * FROM pg_stat_activity WHERE pid = ${holderPid}; if it is stuck, ` +
            `end it with SELECT pg_terminate_backend(${holderPid}).`
          : 'Find the holder in pg_locks (locktype = \'advisory\') joined to pg_stat_activity.';
      throw new MigrationLockTimeoutError(
        `${label} Gave up after ${formatSeconds(timeoutMs)} waiting for migration lock "${key}": ` +
          `${describeHolder(lookup)}. Another process is still migrating this database, or a ` +
          `stuck session is holding the lock. ${remedy} To wait longer, raise ` +
          `${MIGRATION_LOCK_TIMEOUT_ENV} (currently ${timeoutMs}).`,
        key,
        timeoutMs,
        holderPid,
      );
    }

    if (lastProgressLogAt === null || now() - lastProgressLogAt >= progressLogIntervalMs) {
      lastProgressLogAt = now();
      const lookup = await lookUpHolder(conn, key);
      logger.warn(
        `${label} Waiting for migration lock "${key}" (${formatSeconds(elapsed)} of ` +
          `${formatSeconds(timeoutMs)}): ${describeHolder(lookup)}`,
      );
    }

    // Measure again: the holder lookup above also takes time.
    const remaining = timeoutMs - (now() - startedAt);
    await sleep(Math.max(0, Math.min(pollIntervalMs, remaining)));
  }
}

/** Release a lock taken by {@link acquireMigrationAdvisoryLock}, on the same connection. */
export async function releaseMigrationAdvisoryLock(conn: postgres.Sql, key: string): Promise<void> {
  await conn`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
}
