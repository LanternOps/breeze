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
