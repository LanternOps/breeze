import './setup';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMigrate, CORE_MIGRATION_LOCK_KEY } from '../../db/autoMigrate';
import {
  MigrationLockTimeoutError,
  acquireMigrationAdvisoryLock,
  releaseMigrationAdvisoryLock,
} from '../../db/migrationAdvisoryLock';

/**
 * Real-Postgres proof of the bounded migration advisory lock (#4144 item 5):
 * two live sessions contending for one key, as two migrators booting against
 * the same database would. The unit tests (db/migrationAdvisoryLock.test.ts)
 * drive the same logic with a fake connection and a fake clock; this file is
 * what shows the pg_try_advisory_lock / pg_locks SQL actually behaves that way
 * on a server, including the bigint-key → pg_locks (classid, objid) mapping the
 * holder lookup depends on.
 */

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

// A key no real migrator uses, so these cases never contend with anything else.
const TEST_KEY = 'breeze-test:migration-lock-4144';

let first: Sql;
let second: Sql;
let observer: Sql;

beforeEach(() => {
  first = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  second = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  observer = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
});

afterEach(async () => {
  // Ending a session releases any session advisory lock it still holds.
  await first.end({ timeout: 5 });
  await second.end({ timeout: 5 });
  await observer.end({ timeout: 5 });
});

async function backendPid(conn: Sql): Promise<number> {
  const rows = await conn<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return Number(rows[0]!.pid);
}

/** Backend pids currently holding the advisory lock for `key`, seen from a third session. */
async function holdersOf(key: string): Promise<number[]> {
  const rows = await observer<{ pid: number }[]>`
    WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
    SELECT l.pid FROM k, pg_locks l
    WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
      AND l.classid = ((k.v >> 32) & 4294967295)::oid
      AND l.objid = (k.v & 4294967295)::oid`;
  return rows.map((r) => Number(r.pid));
}

/**
 * Backend pids QUEUED on the advisory lock for `key` (an ungranted pg_locks
 * row) — what a blocking `pg_advisory_lock` waiter looks like. A polling
 * waiter never appears here.
 */
async function queuedOn(key: string): Promise<number[]> {
  const rows = await observer<{ pid: number }[]>`
    WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
    SELECT l.pid FROM k, pg_locks l
    WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
      AND l.classid = ((k.v >> 32) & 4294967295)::oid
      AND l.objid = (k.v & 4294967295)::oid`;
  return rows.map((r) => Number(r.pid));
}

function captureLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

describe('bounded migration advisory lock against real Postgres (#4144)', () => {
  it('a second migrator waits, names the holder pid, and takes the lock once the first releases it', async () => {
    const firstPid = await backendPid(first);
    const secondPid = await backendPid(second);
    await acquireMigrationAdvisoryLock(first, TEST_KEY, {
      label: '[first]',
      timeoutMs: 5_000,
      logger: captureLogger(),
    });
    expect(await holdersOf(TEST_KEY)).toEqual([firstPid]);

    const secondLogger = captureLogger();
    const secondAcquire = acquireMigrationAdvisoryLock(second, TEST_KEY, {
      label: '[second]',
      timeoutMs: 20_000,
      pollIntervalMs: 25,
      logger: secondLogger,
    });

    // The waiting line names the first session's backend pid — the holder
    // lookup found it in pg_locks.
    await vi.waitFor(() => expect(secondLogger.warn).toHaveBeenCalled(), { timeout: 10_000, interval: 25 });
    expect(String(secondLogger.warn.mock.calls[0]![0])).toContain(`held by backend pid ${firstPid}`);
    // Waiting is polling, not a server-side lock wait that pins the backend:
    // the second session is never queued on the lock (a blocking
    // pg_advisory_lock would show here as an ungranted row).
    expect(await queuedOn(TEST_KEY)).toEqual([]);
    expect(await holdersOf(TEST_KEY)).toEqual([firstPid]);

    await releaseMigrationAdvisoryLock(first, TEST_KEY);
    await secondAcquire;

    expect(await holdersOf(TEST_KEY)).toEqual([secondPid]);
    expect(String(secondLogger.log.mock.calls.at(-1)?.[0])).toMatch(/acquired after/);
    await releaseMigrationAdvisoryLock(second, TEST_KEY);
    expect(await holdersOf(TEST_KEY)).toEqual([]);
  });

  it('a second migrator gives up at the deadline with the holder pid, holding nothing', async () => {
    const firstPid = await backendPid(first);
    await acquireMigrationAdvisoryLock(first, TEST_KEY, {
      label: '[first]',
      timeoutMs: 5_000,
      logger: captureLogger(),
    });

    // Same monotonic clock the helper measures its deadline with.
    const startedAt = performance.now();
    const error = await acquireMigrationAdvisoryLock(second, TEST_KEY, {
      label: '[second]',
      timeoutMs: 600,
      pollIntervalMs: 50,
      logger: captureLogger(),
    }).catch((e: unknown) => e);
    const waitedMs = performance.now() - startedAt;

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    expect((error as MigrationLockTimeoutError).holderPid).toBe(firstPid);
    expect((error as Error).message).toContain(`pg_terminate_backend(${firstPid})`);
    expect(waitedMs).toBeGreaterThanOrEqual(600);
    expect(waitedMs).toBeLessThan(10_000);
    // The loser holds no advisory lock at all, so its exit leaks nothing.
    const held = await second<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
    expect(held[0]!.n).toBe(0);
    expect(await holdersOf(TEST_KEY)).toEqual([firstPid]);
  });

  it('autoMigrate() fails fast, naming the holder, when a stuck session holds the core migration lock', async () => {
    const holderPid = await backendPid(first);
    // The old blocking primitive, as a wedged migrator (or a stuck manual
    // `db:migrate`) would hold it.
    await first`SELECT pg_advisory_lock(hashtextextended(${CORE_MIGRATION_LOCK_KEY}, 0))`;

    const logger = captureLogger();
    const startedAt = Date.now();
    const error = await autoMigrate({ lockWait: { timeoutMs: 800, pollIntervalMs: 50, logger } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    const timeout = error as MigrationLockTimeoutError;
    expect(timeout.lockKey).toBe(CORE_MIGRATION_LOCK_KEY);
    expect(timeout.holderPid).toBe(holderPid);
    expect(timeout.message).toContain('[auto-migrate]');
    expect(timeout.message).toContain('MIGRATION_LOCK_TIMEOUT_MS');
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain(`held by backend pid ${holderPid}`);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // The stuck session still holds it; autoMigrate took nothing and left.
    expect(await holdersOf(CORE_MIGRATION_LOCK_KEY)).toEqual([holderPid]);
  });
});
