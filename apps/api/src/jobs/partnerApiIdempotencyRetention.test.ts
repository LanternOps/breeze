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

// Real table, not mocked: asserting the reaper targets the table it claims to
// is only meaningful against the actual schema object.
import { partnerApiIdempotencyKeys } from '../db/schema';
import {
  __testOnly,
  createPartnerApiIdempotencyRetentionWorker,
  initializePartnerApiIdempotencyRetentionWorker,
  schedulePartnerApiIdempotencyRetention,
  shutdownPartnerApiIdempotencyRetentionWorker,
} from './partnerApiIdempotencyRetention';

const ORIGINAL_ENABLED = process.env.PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED;
const ORIGINAL_DAYS = process.env.PARTNER_API_IDEMPOTENCY_RETENTION_DAYS;

/** Flattens a drizzle condition to its static text (column names, operators, bound dates). */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  if (q instanceof Date) return q.toISOString();
  const obj = q as { queryChunks?: unknown[]; value?: unknown; name?: string; columnType?: unknown };
  if (typeof obj.name === 'string' && 'columnType' in obj) return obj.name;
  if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(sqlText).join(' ');
  if (Array.isArray(obj.value)) return (obj.value as unknown[]).map(sqlText).join('');
  if (obj.value instanceof Date) return obj.value.toISOString();
  if (typeof obj.value === 'string' || typeof obj.value === 'number') return String(obj.value);
  return '';
}

function restore(name: string, original: string | undefined) {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

describe('partnerApiIdempotencyRetention worker', () => {
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
    delete process.env.PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED;
    delete process.env.PARTNER_API_IDEMPOTENCY_RETENTION_DAYS;
  });

  afterEach(async () => {
    await shutdownPartnerApiIdempotencyRetentionWorker();
    restore('PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED', ORIGINAL_ENABLED);
    restore('PARTNER_API_IDEMPOTENCY_RETENTION_DAYS', ORIGINAL_DAYS);
    vi.useRealTimers();
  });

  it('is allocated a daily-tier slot of its own in the schedule registry', () => {
    expect(__testOnly.DAILY_CRON).toBe('18 4 * * *');
    expect(__testOnly.JOB_NAME).toBe('partner-api-idempotency-retention');
    expect(__testOnly.REPEAT_JOB_ID).toBe('partner-api-idempotency-retention');
    expect(__testOnly.QUEUE_NAME).not.toContain(':');
  });

  it('isRetentionEnabled defaults ON and accepts standard falsy values', () => {
    expect(__testOnly.isRetentionEnabled()).toBe(true);
    for (const off of ['false', '0', 'off', 'no']) {
      process.env.PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED = off;
      expect(__testOnly.isRetentionEnabled()).toBe(false);
    }
    process.env.PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED = 'true';
    expect(__testOnly.isRetentionEnabled()).toBe(true);
  });

  it('getRetentionDays defaults to 7 and falls back for invalid values', () => {
    expect(__testOnly.getRetentionDays()).toBe(7);
    expect(__testOnly.DEFAULT_RETENTION_DAYS).toBe(7);
    process.env.PARTNER_API_IDEMPOTENCY_RETENTION_DAYS = '30';
    expect(__testOnly.getRetentionDays()).toBe(30);
    for (const bad of ['not-a-number', '-5', '0']) {
      process.env.PARTNER_API_IDEMPOTENCY_RETENTION_DAYS = bad;
      expect(__testOnly.getRetentionDays()).toBe(7);
    }
  });

  describe('scheduling', () => {
    it('registers the daily cron with a stable jobId for multi-replica dedup, replacing prior repeatables', async () => {
      getRepeatableJobsMock.mockResolvedValue([
        { name: 'partner-api-idempotency-retention', key: 'old-key' },
        { name: 'unrelated-job', key: 'other-key' },
      ]);
      await schedulePartnerApiIdempotencyRetention();
      expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
      expect(addMock).toHaveBeenCalledTimes(1);
      const [name, data, opts] = addMock.mock.calls[0]!;
      expect(name).toBe('partner-api-idempotency-retention');
      expect(data).toEqual({});
      expect(opts).toMatchObject({ jobId: 'partner-api-idempotency-retention', repeat: { pattern: '18 4 * * *' } });
    });

    it('kill switch (PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED=false) prevents scheduling — independently of the enrollment-key sweep', async () => {
      process.env.PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED = 'false';
      process.env.ENROLLMENT_KEY_CLEANUP_ENABLED = 'true';
      await schedulePartnerApiIdempotencyRetention();
      expect(addMock).not.toHaveBeenCalled();
      delete process.env.ENROLLMENT_KEY_CLEANUP_ENABLED;
    });
  });

  describe('worker processor', () => {
    it('deletes claims older than the retention window on the created_at path, in a system DB context', async () => {
      process.env.PARTNER_API_IDEMPOTENCY_RETENTION_DAYS = '14';
      vi.useFakeTimers();
      const now = new Date('2026-11-10T00:00:00.000Z');
      vi.setSystemTime(now);
      returningMock.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

      createPartnerApiIdempotencyRetentionWorker();
      const result = await capturedWorkerProcessor.current!({ name: 'partner-api-idempotency-retention', id: 'j1' });

      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock.mock.calls[0]![0]).toBe(partnerApiIdempotencyKeys);
      const text = sqlText(whereMock.mock.calls[0]![0]);
      expect(text).toContain('created_at');
      expect(text).toContain('<');
      expect(text).toContain(new Date(now.getTime() - 14 * 86_400_000).toISOString());
      expect(result).toMatchObject({ deletedCount: 2 });
    });

    it('ignores unknown job names without touching the DB', async () => {
      createPartnerApiIdempotencyRetentionWorker();
      const result = await capturedWorkerProcessor.current!({ name: 'something-else', id: 'j2' });
      expect(deleteMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ skipped: true, deletedCount: 0 });
    });
  });

  it('initialize creates the worker, schedules the cron, and shuts down idempotently', async () => {
    await initializePartnerApiIdempotencyRetentionWorker();
    expect(addMock).toHaveBeenCalledTimes(1);
    await shutdownPartnerApiIdempotencyRetentionWorker();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
    await shutdownPartnerApiIdempotencyRetentionWorker();
  });
});
