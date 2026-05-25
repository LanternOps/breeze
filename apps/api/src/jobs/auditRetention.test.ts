/**
 * Unit tests for the audit-log retention worker (Task 29).
 *
 * Mirrors the oauthCleanup.test.ts mocking pattern — BullMQ + db are
 * stubbed so we can assert on schedule registration, processor
 * dispatch, and policy-loop control flow without a real Postgres.
 *
 * End-to-end DELETE behavior (the bypass role + session GUC + trigger
 * change) lives in
 * `__tests__/integration/audit-retention.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dbExecuteMock: vi.fn(),
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
      execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
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
  createAuditRetentionWorker,
  initializeAuditRetentionWorker,
  pruneExpiredAuditLogs,
  scheduleAuditRetention,
  shutdownAuditRetentionWorker,
} from './auditRetention';

const ORIGINAL_FLAG = process.env.AUDIT_RETENTION_ENABLED;

describe('auditRetention worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue([]);
    capturedWorkerProcessor.current = null;
    delete process.env.AUDIT_RETENTION_ENABLED;
  });

  afterEach(async () => {
    await shutdownAuditRetentionWorker();
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.AUDIT_RETENTION_ENABLED;
    } else {
      process.env.AUDIT_RETENTION_ENABLED = ORIGINAL_FLAG;
    }
  });

  it('exposes the daily cron pattern at 03:30 UTC', () => {
    expect(__testOnly.DAILY_CRON).toBe('30 3 * * *');
    expect(__testOnly.JOB_NAME).toBe('audit-log-retention');
    expect(__testOnly.REPEAT_JOB_ID).toBe('audit-log-retention');
  });

  it('isRetentionEnabled defaults ON and accepts standard falsy values', () => {
    delete process.env.AUDIT_RETENTION_ENABLED;
    expect(__testOnly.isRetentionEnabled()).toBe(true);
    process.env.AUDIT_RETENTION_ENABLED = 'false';
    expect(__testOnly.isRetentionEnabled()).toBe(false);
    process.env.AUDIT_RETENTION_ENABLED = '0';
    expect(__testOnly.isRetentionEnabled()).toBe(false);
    process.env.AUDIT_RETENTION_ENABLED = 'off';
    expect(__testOnly.isRetentionEnabled()).toBe(false);
    process.env.AUDIT_RETENTION_ENABLED = 'true';
    expect(__testOnly.isRetentionEnabled()).toBe(true);
  });

  it('scheduleAuditRetention registers the daily cron with a stable jobId for multi-replica dedup', async () => {
    await scheduleAuditRetention();
    expect(addMock).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('audit-log-retention');
    expect(data).toEqual({});
    expect(opts).toMatchObject({
      jobId: 'audit-log-retention',
      repeat: { pattern: '30 3 * * *' },
    });
  });

  it('scheduleAuditRetention removes prior repeatable jobs before adding a fresh one', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'audit-log-retention', key: 'old-key' },
      { name: 'unrelated-job', key: 'other-key' },
    ]);
    await scheduleAuditRetention();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('scheduleAuditRetention skips registration when AUDIT_RETENTION_ENABLED is false', async () => {
    process.env.AUDIT_RETENTION_ENABLED = 'false';
    await scheduleAuditRetention();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('worker processor delegates to pruneExpiredAuditLogs for the right job name', async () => {
    dbExecuteMock.mockResolvedValueOnce([]); // empty policy list
    createAuditRetentionWorker();
    expect(capturedWorkerProcessor.current).toBeTypeOf('function');
    const result = (await capturedWorkerProcessor.current!({
      name: 'audit-log-retention',
      id: 'j1',
    })) as { policies: number; rowsDeleted: number };
    expect(result.policies).toBe(0);
    expect(result.rowsDeleted).toBe(0);
  });

  it('worker processor ignores unknown job names', async () => {
    createAuditRetentionWorker();
    const result = (await capturedWorkerProcessor.current!({
      name: 'something-else',
      id: 'j2',
    })) as { skipped: boolean };
    expect(result.skipped).toBe(true);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });

  describe('pruneExpiredAuditLogs', () => {
    it('returns zero-stats when no policies exist', async () => {
      dbExecuteMock.mockResolvedValueOnce([]);
      const stats = await pruneExpiredAuditLogs();
      expect(stats.policies).toBe(0);
      expect(stats.orgsPruned).toBe(0);
      expect(stats.rowsDeleted).toBe(0);
      expect(stats.errors).toBe(0);
    });

    it('issues SET LOCAL ROLE + SET LOCAL GUC before DELETE for each policy', async () => {
      dbExecuteMock
        .mockResolvedValueOnce([
          { id: 'p1', org_id: 'org-a', retention_days: 30 },
        ]) // policy list
        .mockResolvedValueOnce(undefined) // SET LOCAL ROLE
        .mockResolvedValueOnce(undefined) // SET LOCAL GUC
        .mockResolvedValueOnce({ rowCount: 5 }) // DELETE
        .mockResolvedValueOnce(undefined); // UPDATE last_cleanup_at

      const stats = await pruneExpiredAuditLogs();
      expect(stats.policies).toBe(1);
      expect(stats.orgsPruned).toBe(1);
      expect(stats.rowsDeleted).toBe(5);
      expect(stats.errors).toBe(0);

      // 1 select + 3 (role/guc/delete) + 1 update = 5 calls total.
      expect(dbExecuteMock).toHaveBeenCalledTimes(5);

      // The role-switch and GUC-set must run before the DELETE. Drizzle's
      // sql template carries the literal in `queryChunks` (an array of
      // strings + bound params). Stringify the first chunk to assert on.
      const callTexts = dbExecuteMock.mock.calls.map((call: unknown[]) => {
        const q = call[0];
        const sqlObj = q as { queryChunks?: Array<{ value?: string[] } | string> };
        if (Array.isArray(sqlObj.queryChunks)) {
          return sqlObj.queryChunks
            .map((c) => (typeof c === 'string' ? c : Array.isArray((c as { value?: unknown }).value) ? ((c as { value: string[] }).value).join('') : ''))
            .join(' ');
        }
        return String(q);
      });
      expect(callTexts[1]).toMatch(/SET LOCAL ROLE breeze_audit_admin/);
      expect(callTexts[2]).toMatch(/SET LOCAL breeze\.allow_audit_retention/);
      expect(callTexts[3]).toMatch(/DELETE FROM audit_logs/);
    });

    it('continues to the next policy when one fails', async () => {
      dbExecuteMock
        .mockResolvedValueOnce([
          { id: 'p1', org_id: 'org-a', retention_days: 30 },
          { id: 'p2', org_id: 'org-b', retention_days: 365 },
        ]) // policy list
        // org-a: role, guc, DELETE fails
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('connection lost'))
        // org-b: role, guc, DELETE ok, UPDATE ok
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rowCount: 3 })
        .mockResolvedValueOnce(undefined);

      const stats = await pruneExpiredAuditLogs();
      expect(stats.policies).toBe(2);
      expect(stats.orgsPruned).toBe(1); // only org-b succeeded
      expect(stats.rowsDeleted).toBe(3);
      expect(stats.errors).toBe(1);
    });

    it('records last_cleanup_at outside the role-switched transaction', async () => {
      dbExecuteMock
        .mockResolvedValueOnce([
          { id: 'p1', org_id: 'org-a', retention_days: 30 },
        ])
        .mockResolvedValueOnce(undefined) // SET LOCAL ROLE
        .mockResolvedValueOnce(undefined) // SET LOCAL GUC
        .mockResolvedValueOnce({ rowCount: 0 }) // DELETE (no rows)
        .mockResolvedValueOnce(undefined); // UPDATE

      await pruneExpiredAuditLogs();

      // The retention-policy update must run in a separate
      // withSystemDbAccessContext call from the DELETE so it commits
      // independently. Mock invocations: 1 for policy SELECT, 1 for
      // role-switch+DELETE tx, 1 for UPDATE tx = 3 total.
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(3);

      const updateCall = dbExecuteMock.mock.calls.at(-1)?.[0] as {
        queryChunks?: Array<{ value?: string[] } | string>;
      };
      const updateText = Array.isArray(updateCall?.queryChunks)
        ? updateCall.queryChunks
            .map((c) => (typeof c === 'string' ? c : Array.isArray((c as { value?: unknown }).value) ? ((c as { value: string[] }).value).join('') : ''))
            .join(' ')
        : String(updateCall);
      expect(updateText).toMatch(/UPDATE audit_retention_policies/);
    });
  });

  it('initializeAuditRetentionWorker creates worker, schedules cron, and is idempotent on shutdown', async () => {
    await initializeAuditRetentionWorker();
    expect(addMock).toHaveBeenCalledTimes(1);
    await shutdownAuditRetentionWorker();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
    // Second shutdown must not throw or double-close.
    await shutdownAuditRetentionWorker();
  });
});
