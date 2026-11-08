import type postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  MIGRATION_LOCK_TIMEOUT_ENV,
  MigrationLockTimeoutError,
  acquireMigrationAdvisoryLock,
  releaseMigrationAdvisoryLock,
  resolveMigrationLockTimeoutMs,
} from './migrationAdvisoryLock';

/**
 * Unit tests for the bounded migration advisory lock (#4144 item 5). The fake
 * connection below stands in for a postgres.js client: it answers the two
 * queries the helper issues (`pg_try_advisory_lock` and the pg_locks holder
 * lookup) from a scripted queue, and a fake clock replaces real sleeping so a
 * five-minute deadline runs in microseconds. The real-Postgres half (two live
 * migrators contending) is in
 * `__tests__/integration/migrationAdvisoryLock.integration.test.ts`.
 */

interface FakeHolder {
  pid: number;
  application_name: string | null;
  client_addr: string | null;
  state: string | null;
  backend_start: string | null;
}

interface FakeConnOptions {
  /** Successive `pg_try_advisory_lock` answers; the last one repeats. */
  tryResults: Array<boolean | 'no-row' | Error>;
  holder?: FakeHolder | null | Error;
  /** Clock advanced by each query, so a run of attempts uses up the deadline. */
  clock?: { t: number };
  queryCostMs?: number;
}

function fakeConn(opts: FakeConnOptions) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let attempt = 0;
  const fn = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, values });
    if (opts.clock && opts.queryCostMs) opts.clock.t += opts.queryCostMs;
    if (text.includes('pg_try_advisory_lock(')) {
      const answer = opts.tryResults[Math.min(attempt, opts.tryResults.length - 1)];
      attempt += 1;
      if (answer instanceof Error) throw answer;
      if (answer === 'no-row') return [];
      return [{ locked: answer }];
    }
    if (text.includes('pg_locks')) {
      if (opts.holder instanceof Error) throw opts.holder;
      return opts.holder ? [opts.holder] : [];
    }
    if (text.includes('pg_advisory_unlock(')) return [{ unlocked: true }];
    throw new Error(`fake connection: unexpected query ${text}`);
  });
  return {
    conn: fn as unknown as postgres.Sql,
    queries,
    tryCount: () => queries.filter((q) => q.text.includes('pg_try_advisory_lock(')).length,
    holderLookups: () => queries.filter((q) => q.text.includes('pg_locks')).length,
  };
}

function fakeClock() {
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  return {
    clock,
    sleeps,
    now: () => clock.t,
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    }),
  };
}

function captureLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const HOLDER: FakeHolder = {
  pid: 4242,
  application_name: 'psql',
  client_addr: '192.0.2.10',
  state: 'idle in transaction',
  backend_start: '2026-11-08T10:00:00.000Z',
};

describe('resolveMigrationLockTimeoutMs', () => {
  it('defaults to a few minutes when the variable is unset or empty (compose passes "")', () => {
    expect(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS).toBe(300_000);
    expect(resolveMigrationLockTimeoutMs({})).toBe(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
    expect(resolveMigrationLockTimeoutMs({ [MIGRATION_LOCK_TIMEOUT_ENV]: '' })).toBe(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
    expect(resolveMigrationLockTimeoutMs({ [MIGRATION_LOCK_TIMEOUT_ENV]: '   ' })).toBe(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
  });

  it('reads a positive whole number of milliseconds', () => {
    expect(MIGRATION_LOCK_TIMEOUT_ENV).toBe('MIGRATION_LOCK_TIMEOUT_MS');
    expect(resolveMigrationLockTimeoutMs({ MIGRATION_LOCK_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(resolveMigrationLockTimeoutMs({ MIGRATION_LOCK_TIMEOUT_MS: ' 1800000 ' })).toBe(1_800_000);
  });

  it.each(['0', '-5', 'abc', '10m', '1.5', '5e3', '0x10', '99999999999999999999'])(
    'refuses %j rather than silently waiting a different amount of time',
    (raw) => {
      expect(() => resolveMigrationLockTimeoutMs({ MIGRATION_LOCK_TIMEOUT_MS: raw })).toThrow(
        /MIGRATION_LOCK_TIMEOUT_MS must be a positive whole number of milliseconds/,
      );
    },
  );
});

describe('acquireMigrationAdvisoryLock', () => {
  it('takes the lock with a single non-blocking try when it is free (no wait, no log)', async () => {
    const { conn, queries, holderLookups } = fakeConn({ tryResults: [true] });
    const time = fakeClock();
    const logger = captureLogger();

    await acquireMigrationAdvisoryLock(conn, 'breeze-core-migrations', {
      label: '[auto-migrate]',
      timeoutMs: 60_000,
      logger,
      now: time.now,
      sleep: time.sleep,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain('pg_try_advisory_lock(hashtextextended(');
    // The key is bound as a parameter, never spliced into the SQL text.
    expect(queries[0]!.text).not.toContain('breeze-core-migrations');
    expect(queries[0]!.values).toEqual(['breeze-core-migrations']);
    // The blocking primitive is gone: nothing here may wait unboundedly.
    expect(queries[0]!.text).not.toMatch(/\bpg_advisory_lock\(/);
    expect(holderLookups()).toBe(0);
    expect(time.sleep).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retries while another session holds the lock and names the holder pid once it is contended', async () => {
    const { conn, tryCount } = fakeConn({ tryResults: [false, false, true], holder: HOLDER });
    const time = fakeClock();
    const logger = captureLogger();

    await acquireMigrationAdvisoryLock(conn, 'breeze-core-migrations', {
      label: '[auto-migrate]',
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      logger,
      now: time.now,
      sleep: time.sleep,
    });

    expect(tryCount()).toBe(3);
    expect(time.sleeps).toEqual([1_000, 1_000]);
    const waitLines = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(waitLines[0]).toContain('[auto-migrate]');
    expect(waitLines[0]).toContain('breeze-core-migrations');
    expect(waitLines[0]).toContain('pid 4242');
    expect(waitLines[0]).toContain('psql');
    expect(waitLines[0]).toContain('idle in transaction');
    // Acquisition after a wait is reported, so the log shows the wait ended.
    expect(logger.log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/acquired .*after/i);
  });

  it('gives up at the deadline with an error naming the holder pid, the timeout and the env knob', async () => {
    const time = fakeClock();
    const { conn, tryCount } = fakeConn({ tryResults: [false], holder: HOLDER });
    const logger = captureLogger();

    const error = await acquireMigrationAdvisoryLock(conn, 'breeze-extension:demo', {
      label: '[extensions]',
      timeoutMs: 10_000,
      pollIntervalMs: 2_000,
      logger,
      now: time.now,
      sleep: time.sleep,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    const timeout = error as MigrationLockTimeoutError;
    expect(timeout.lockKey).toBe('breeze-extension:demo');
    expect(timeout.timeoutMs).toBe(10_000);
    expect(timeout.holderPid).toBe(4242);
    expect(timeout.message).toContain('[extensions]');
    expect(timeout.message).toContain('pid 4242');
    expect(timeout.message).toContain('10s');
    expect(timeout.message).toContain('MIGRATION_LOCK_TIMEOUT_MS');
    expect(timeout.message).toContain('pg_terminate_backend(4242)');
    // Bounded: an attempt at t=0 plus one per 2s interval up to and including
    // the deadline itself (0,2,4,6,8,10s) — then it stops.
    expect(tryCount()).toBe(6);
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('never sleeps past the deadline when the poll interval does not divide it', async () => {
    const time = fakeClock();
    const { conn } = fakeConn({ tryResults: [false], holder: HOLDER });

    await expect(
      acquireMigrationAdvisoryLock(conn, 'k', {
        label: '[auto-migrate]',
        timeoutMs: 5_000,
        pollIntervalMs: 2_000,
        logger: captureLogger(),
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    expect(time.sleeps).toEqual([2_000, 2_000, 1_000]);
  });

  it('counts the time spent inside the queries themselves against the deadline', async () => {
    const time = fakeClock();
    // Each query takes 3s of wall clock; with a 1s poll interval a 5s deadline
    // must still stop after ~2 attempts, not after five sleeps.
    const { conn, tryCount } = fakeConn({ tryResults: [false], holder: HOLDER, clock: time.clock, queryCostMs: 3_000 });

    await expect(
      acquireMigrationAdvisoryLock(conn, 'k', {
        label: '[auto-migrate]',
        timeoutMs: 5_000,
        pollIntervalMs: 1_000,
        logger: captureLogger(),
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    // t=0 try (→3s), progress lookup (→6s), deadline already passed so the
    // sleep is 0, t=6s try (→9s) → over the deadline → throw. Exactly two.
    expect(tryCount()).toBe(2);
  });

  it('still times out — with "holder unknown" — when the holder lookup itself fails', async () => {
    const time = fakeClock();
    const { conn } = fakeConn({ tryResults: [false], holder: new Error('permission denied for pg_locks') });
    const logger = captureLogger();

    const error = await acquireMigrationAdvisoryLock(conn, 'k', {
      label: '[auto-migrate]',
      timeoutMs: 4_000,
      pollIntervalMs: 2_000,
      logger,
      now: time.now,
      sleep: time.sleep,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    expect((error as MigrationLockTimeoutError).holderPid).toBeNull();
    expect((error as Error).message).toMatch(/holder could not be identified/i);
    // The lookup failure is reported, not swallowed.
    expect((error as Error).message).toContain('permission denied for pg_locks');
  });

  it('reports a holder that vanished between the failed try and the lookup as such', async () => {
    const time = fakeClock();
    const { conn } = fakeConn({ tryResults: [false, true], holder: null });
    const logger = captureLogger();

    await acquireMigrationAdvisoryLock(conn, 'k', {
      label: '[auto-migrate]',
      timeoutMs: 10_000,
      pollIntervalMs: 1_000,
      logger,
      now: time.now,
      sleep: time.sleep,
    });

    expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(/no holder found/i);
  });

  it('repeats the waiting line at most once per progress interval, not on every poll', async () => {
    const time = fakeClock();
    // 30 failed polls at 1s, then success.
    const tries: boolean[] = [...Array<boolean>(30).fill(false), true];
    const { conn, holderLookups } = fakeConn({ tryResults: tries, holder: HOLDER });
    const logger = captureLogger();

    await acquireMigrationAdvisoryLock(conn, 'k', {
      label: '[auto-migrate]',
      timeoutMs: 120_000,
      pollIntervalMs: 1_000,
      progressLogIntervalMs: 10_000,
      logger,
      now: time.now,
      sleep: time.sleep,
    });

    // First contention (t=0) plus t=10s, 20s — three lines for a 30s wait.
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(holderLookups()).toBe(3);
  });

  it('propagates a failing try query instead of retrying it as contention', async () => {
    const time = fakeClock();
    const { conn, tryCount } = fakeConn({ tryResults: [new Error('connection terminated')] });

    await expect(
      acquireMigrationAdvisoryLock(conn, 'k', {
        label: '[auto-migrate]',
        timeoutMs: 60_000,
        logger: captureLogger(),
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toThrow('connection terminated');
    expect(tryCount()).toBe(1);
  });

  it('throws on a malformed try result rather than reading it as "not acquired"', async () => {
    const time = fakeClock();
    const { conn, tryCount } = fakeConn({ tryResults: ['no-row'] });

    await expect(
      acquireMigrationAdvisoryLock(conn, 'k', {
        label: '[auto-migrate]',
        timeoutMs: 60_000,
        logger: captureLogger(),
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toThrow(/unexpected result/i);
    expect(tryCount()).toBe(1);
  });

  it('resolves the deadline from MIGRATION_LOCK_TIMEOUT_MS when no timeoutMs is passed', async () => {
    const time = fakeClock();
    const { conn, tryCount } = fakeConn({ tryResults: [false], holder: HOLDER });
    vi.stubEnv('MIGRATION_LOCK_TIMEOUT_MS', '3000');
    try {
      const error = await acquireMigrationAdvisoryLock(conn, 'k', {
        label: '[auto-migrate]',
        pollIntervalMs: 1_000,
        logger: captureLogger(),
        now: time.now,
        sleep: time.sleep,
      }).catch((e: unknown) => e);
      expect((error as MigrationLockTimeoutError).timeoutMs).toBe(3_000);
      expect(tryCount()).toBe(4);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a bad env value before touching the database', async () => {
    const { conn, queries } = fakeConn({ tryResults: [true] });
    vi.stubEnv('MIGRATION_LOCK_TIMEOUT_MS', '5min');
    try {
      await expect(
        acquireMigrationAdvisoryLock(conn, 'k', { label: '[auto-migrate]', logger: captureLogger() }),
      ).rejects.toThrow(/MIGRATION_LOCK_TIMEOUT_MS/);
      expect(queries).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects an explicit timeoutMs of %s', async (timeoutMs) => {
    const { conn, queries } = fakeConn({ tryResults: [true] });
    await expect(
      acquireMigrationAdvisoryLock(conn, 'k', { label: '[auto-migrate]', timeoutMs, logger: captureLogger() }),
    ).rejects.toThrow(/timeoutMs/);
    expect(queries).toHaveLength(0);
  });
});

describe('releaseMigrationAdvisoryLock', () => {
  it('unlocks the same key, parameter-bound', async () => {
    const { conn, queries } = fakeConn({ tryResults: [true] });
    await releaseMigrationAdvisoryLock(conn, 'breeze-core-migrations');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain('pg_advisory_unlock(hashtextextended(');
    expect(queries[0]!.values).toEqual(['breeze-core-migrations']);
  });
});
