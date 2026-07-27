import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  deleteMock,
  whereMock,
  returningMock,
  selectMock,
  withSystemDbAccessContextMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  deleteMock: vi.fn(),
  whereMock: vi.fn(),
  returningMock: vi.fn(),
  selectMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      this.name = name;
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
    db: {
      delete: (...args: unknown[]) => deleteMock(...(args as [])),
      select: (...args: unknown[]) => selectMock(...(args as [])),
    },
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { sql } from 'drizzle-orm';
import {
  __testOnly,
  createEnrollmentKeyCleanupWorker,
  initializeEnrollmentKeyCleanupWorker,
  scheduleEnrollmentKeyCleanup,
  shutdownEnrollmentKeyCleanupWorker,
} from './enrollmentKeyCleanup';

const ORIGINAL_ENABLED_FLAG = process.env.ENROLLMENT_KEY_CLEANUP_ENABLED;
const ORIGINAL_PURGE_DAYS = process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS;

/**
 * Flattens a drizzle condition (built via `and`/`lt`/`isNotNull`) to its
 * static text — column names and operator/keyword chunks. Bound Date values
 * are rendered via `toISOString()`. Same introspection approach as
 * `ticketSlaWorker.test.ts` / `auditRetention.test.ts`, extended to resolve
 * drizzle column objects (which carry a `columnType` + `name`) to their
 * column name instead of recursing into the table they belong to (which is
 * circular).
 *
 * Also resolves the correlated NOT EXISTS subquery added for #2775: `and`/
 * `notExists` embed the subquery as an opaque `SQLWrapper` chunk (an object
 * exposing only `getSQL()`, per drizzle's own `isSQLWrapper` duck-typing —
 * `sql/sql.js`), which none of the shape checks above recognize. The
 * `getSQL` fallback below is checked LAST (after the queryChunks/value/name
 * branches, which real `SQL`/`Column` instances always satisfy first) so it
 * only ever fires for this kind of otherwise-unhandled wrapper, then
 * recurses into whatever real `SQL` object `getSQL()` returns.
 */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  if (q instanceof Date) return q.toISOString();
  const obj = q as {
    queryChunks?: unknown[];
    value?: unknown;
    name?: string;
    columnType?: unknown;
    getSQL?: () => unknown;
  };
  if (typeof obj.name === 'string' && 'columnType' in obj) {
    return obj.name;
  }
  if (Array.isArray(obj.queryChunks)) {
    return obj.queryChunks.map(sqlText).join(' ');
  }
  if (Array.isArray(obj.value)) {
    return (obj.value as unknown[]).map(sqlText).join('');
  }
  if (obj.value instanceof Date) {
    return obj.value.toISOString();
  }
  if (typeof obj.value === 'string' || typeof obj.value === 'number') {
    return String(obj.value);
  }
  if (typeof obj.getSQL === 'function') {
    return sqlText(obj.getSQL());
  }
  return '';
}

describe('enrollmentKeyCleanup worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    returningMock.mockResolvedValue([]);
    whereMock.mockImplementation(() => ({ returning: returningMock }));
    deleteMock.mockImplementation(() => ({ where: whereMock }));
    // The exemption subquery (#2775) calls db.select(...).from(...).where(cond)
    // to build a correlated NOT EXISTS subquery. This never executes for
    // real here (no Postgres in this suite) — it only needs to satisfy
    // drizzle's SQLWrapper contract (a `getSQL()` method) so `notExists(...)`
    // can embed it. Wrapping the REAL `cond` built by production code (via
    // the real `and`/`eq`/`gt`/`lt` from drizzle-orm, not mocked) in a `sql`
    // template means the flattened where-clause text below genuinely
    // reflects what the code built, not a canned stand-in.
    selectMock.mockImplementation(() => ({
      from: () => ({
        where: (cond: unknown) => ({
          getSQL: () => sql`select 1 from installer_bootstrap_tokens where ${cond}`,
        }),
      }),
    }));
    capturedWorkerProcessor.current = null;
    delete process.env.ENROLLMENT_KEY_CLEANUP_ENABLED;
    delete process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS;
  });

  afterEach(async () => {
    await shutdownEnrollmentKeyCleanupWorker();
    if (ORIGINAL_ENABLED_FLAG === undefined) {
      delete process.env.ENROLLMENT_KEY_CLEANUP_ENABLED;
    } else {
      process.env.ENROLLMENT_KEY_CLEANUP_ENABLED = ORIGINAL_ENABLED_FLAG;
    }
    if (ORIGINAL_PURGE_DAYS === undefined) {
      delete process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS;
    } else {
      process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = ORIGINAL_PURGE_DAYS;
    }
    vi.useRealTimers();
  });

  it('exposes the daily cron pattern at 04:00 UTC', () => {
    expect(__testOnly.DAILY_CRON).toBe('0 4 * * *');
    expect(__testOnly.JOB_NAME).toBe('enrollment-key-cleanup');
    expect(__testOnly.REPEAT_JOB_ID).toBe('enrollment-key-cleanup');
    expect(__testOnly.QUEUE_NAME).not.toContain(':');
    expect(__testOnly.JOB_NAME).not.toContain(':');
    expect(__testOnly.REPEAT_JOB_ID).not.toContain(':');
  });

  it('isCleanupEnabled defaults ON and accepts standard falsy values', () => {
    delete process.env.ENROLLMENT_KEY_CLEANUP_ENABLED;
    expect(__testOnly.isCleanupEnabled()).toBe(true);
    process.env.ENROLLMENT_KEY_CLEANUP_ENABLED = 'false';
    expect(__testOnly.isCleanupEnabled()).toBe(false);
    process.env.ENROLLMENT_KEY_CLEANUP_ENABLED = '0';
    expect(__testOnly.isCleanupEnabled()).toBe(false);
    process.env.ENROLLMENT_KEY_CLEANUP_ENABLED = 'off';
    expect(__testOnly.isCleanupEnabled()).toBe(false);
    process.env.ENROLLMENT_KEY_CLEANUP_ENABLED = 'true';
    expect(__testOnly.isCleanupEnabled()).toBe(true);
  });

  describe('getPurgeAfterDays', () => {
    it('defaults to 7 days when unset', () => {
      delete process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS;
      expect(__testOnly.getPurgeAfterDays()).toBe(7);
      expect(__testOnly.DEFAULT_PURGE_AFTER_DAYS).toBe(7);
    });

    it('respects a configured integer value', () => {
      process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = '30';
      expect(__testOnly.getPurgeAfterDays()).toBe(30);
    });

    it('falls back to the default for invalid values', () => {
      process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = 'not-a-number';
      expect(__testOnly.getPurgeAfterDays()).toBe(7);
      process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = '-5';
      expect(__testOnly.getPurgeAfterDays()).toBe(7);
      process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = '0';
      expect(__testOnly.getPurgeAfterDays()).toBe(7);
    });
  });

  describe('scheduling', () => {
    it('registers the daily cron with a stable jobId for multi-replica dedup', async () => {
      await scheduleEnrollmentKeyCleanup();
      expect(addMock).toHaveBeenCalledTimes(1);
      const call = addMock.mock.calls[0]!;
      const [name, data, opts] = call;
      expect(name).toBe('enrollment-key-cleanup');
      expect(data).toEqual({});
      expect(opts).toMatchObject({
        jobId: 'enrollment-key-cleanup',
        repeat: { pattern: '0 4 * * *' },
      });
    });

    it('removes prior repeatable jobs before adding a fresh one', async () => {
      getRepeatableJobsMock.mockResolvedValue([
        { name: 'enrollment-key-cleanup', key: 'old-key' },
        { name: 'unrelated-job', key: 'other-key' },
      ]);
      await scheduleEnrollmentKeyCleanup();
      expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
      expect(addMock).toHaveBeenCalledTimes(1);
    });

    it('kill switch (ENROLLMENT_KEY_CLEANUP_ENABLED=false) prevents scheduling', async () => {
      process.env.ENROLLMENT_KEY_CLEANUP_ENABLED = 'false';
      await scheduleEnrollmentKeyCleanup();
      expect(addMock).not.toHaveBeenCalled();
    });
  });

  describe('worker processor', () => {
    it('deletes expired keys within a system DB context and reports the count', async () => {
      returningMock.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }]);
      createEnrollmentKeyCleanupWorker();
      expect(capturedWorkerProcessor.current).toBeTypeOf('function');

      const result = await capturedWorkerProcessor.current!({
        name: 'enrollment-key-cleanup',
        id: 'j1',
      });

      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ deletedCount: 2 });
    });

    it('cutoff math respects ENROLLMENT_KEY_PURGE_AFTER_DAYS', async () => {
      process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS = '14';
      vi.useFakeTimers();
      const now = new Date('2026-07-03T00:00:00.000Z');
      vi.setSystemTime(now);

      createEnrollmentKeyCleanupWorker();
      await capturedWorkerProcessor.current!({ name: 'enrollment-key-cleanup', id: 'j2' });

      expect(whereMock).toHaveBeenCalledTimes(1);
      const cond = whereMock.mock.calls[0]![0];
      const text = sqlText(cond);

      const expectedCutoff = new Date(now.getTime() - 14 * 86_400_000);
      expect(text).toContain(expectedCutoff.toISOString());
    });

    it('null-expiry rows are never matched — where clause carries the not-null guard', async () => {
      createEnrollmentKeyCleanupWorker();
      await capturedWorkerProcessor.current!({ name: 'enrollment-key-cleanup', id: 'j3' });

      expect(whereMock).toHaveBeenCalledTimes(1);
      const cond = whereMock.mock.calls[0]![0];
      const text = sqlText(cond);

      expect(text).toContain('expires_at');
      expect(text).toContain('is not null');
      expect(text).toContain('and');
      expect(text).toContain('<');
    });

    // #2775 fix-round-1: the enrollment_keys DELETE now exempts any key that
    // still has a live, unexhausted installer_bootstrap_tokens row pointing
    // at it (see hasNoLiveUnexhaustedBootstrapToken in enrollmentKeyCleanup.ts).
    // Like the two tests above, these are SQL-shape assertions on the built
    // WHERE clause — this suite has no real Postgres, so the mocked
    // `where()`/`returning()` chain can't itself evaluate a NOT EXISTS
    // subquery per row (`returningMock`'s resolved value is whatever the
    // test tells it to be, independent of the predicate). What IS
    // meaningfully verifiable here — and would fail if the exemption were
    // removed, miswired to the wrong columns, or bound to the wrong "now" —
    // is that the generated predicate matches the owner-approved shape for
    // each of the four required scenarios.
    describe('live bootstrap token exemption (#2775)', () => {
      it('(a) a live, unexhausted token exempts its parent key — subquery correlates on parent_enrollment_key_id and requires the TOKEN itself to still be unexpired', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-07-10T12:00:00.000Z');
        vi.setSystemTime(now);

        createEnrollmentKeyCleanupWorker();
        await capturedWorkerProcessor.current!({ name: 'enrollment-key-cleanup', id: 'j-2775-a' });

        const cond = whereMock.mock.calls[0]![0];
        const text = sqlText(cond);

        expect(text).toContain('not exists');
        expect(text).toContain('parent_enrollment_key_id');
        expect(text).toContain('id'); // correlated column on the outer enrollment_keys row
        // The token-liveness bound is "now" at call time, not the outer
        // days-based purge cutoff — proven by both distinct timestamps
        // appearing, so a 30-day/1-year token isn't accidentally re-clamped
        // to the 7-day purge window.
        const expectedCutoff = new Date(now.getTime() - __testOnly.DEFAULT_PURGE_AFTER_DAYS * 86_400_000);
        expect(text).toContain(expectedCutoff.toISOString());
        expect(text).toContain(now.toISOString());
      });

      it('(b) a token whose own expiry has passed does NOT exempt the key — the liveness check is a strict now() boundary, not a grace window', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-07-10T12:00:00.000Z');
        vi.setSystemTime(now);

        createEnrollmentKeyCleanupWorker();
        await capturedWorkerProcessor.current!({ name: 'enrollment-key-cleanup', id: 'j-2775-b' });

        const cond = whereMock.mock.calls[0]![0];
        const text = sqlText(cond);

        // Extract the operator immediately preceding the bound "now" value:
        // must be strict `>`, not `>=` — an expired token (expires_at <= now)
        // must fail this predicate so NOT EXISTS is satisfied and the key
        // still gets deleted, exactly as before #2775.
        const match = text.match(/expires_at\s+(\S+)\s+2026-07-10T12:00:00\.000Z/);
        expect(match).not.toBeNull();
        expect(match![1]).toBe('>');
      });

      it('(c) a fully-consumed token does NOT exempt the key — subquery requires consumed_count < max_usage', async () => {
        createEnrollmentKeyCleanupWorker();
        await capturedWorkerProcessor.current!({ name: 'enrollment-key-cleanup', id: 'j-2775-c' });

        const cond = whereMock.mock.calls[0]![0];
        const text = sqlText(cond);

        expect(text).toContain('consumed_count');
        expect(text).toContain('max_usage');
        expect(text).toMatch(/consumed_count\s+<\s+max_usage/);
      });

      it('(d) a key with no bootstrap tokens at all is still deleted — existing count-reporting behaviour is unchanged with the guard wired in', async () => {
        returningMock.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }]);
        createEnrollmentKeyCleanupWorker();

        const result = await capturedWorkerProcessor.current!({
          name: 'enrollment-key-cleanup',
          id: 'j-2775-d',
        });

        // NOT EXISTS against zero correlated token rows is trivially true in
        // standard SQL — a key with no bootstrap tokens is unaffected by the
        // new guard and is deleted exactly as it was pre-#2775.
        const cond = whereMock.mock.calls[0]![0];
        expect(sqlText(cond)).toContain('not exists');
        expect(result).toMatchObject({ deletedCount: 3 });
      });
    });

    it('ignores unknown job names without touching the DB', async () => {
      createEnrollmentKeyCleanupWorker();
      const result = await capturedWorkerProcessor.current!({ name: 'something-else', id: 'j4' });
      expect(deleteMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ skipped: true, deletedCount: 0 });
    });
  });

  it('initializeEnrollmentKeyCleanupWorker creates worker, schedules cron, and shuts down idempotently', async () => {
    await initializeEnrollmentKeyCleanupWorker();
    expect(addMock).toHaveBeenCalledTimes(1);
    await shutdownEnrollmentKeyCleanupWorker();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
    // Second shutdown must not throw or double-close.
    await shutdownEnrollmentKeyCleanupWorker();
  });
});
