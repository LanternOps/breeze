import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  dbSelectMock,
  getOrgEventLogRetentionDaysMock,
  attachWorkerObservabilityMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, _label?: string) => fn()),
  dbExecuteMock: vi.fn(),
  dbSelectMock: vi.fn(),
  getOrgEventLogRetentionDaysMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: { data: Record<string, unknown> }) => Promise<any>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: Record<string, unknown> }) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor as never;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
    select: (...args: unknown[]) => dbSelectMock(...(args as [])),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) =>
    withSystemDbAccessContextMock(fn, label),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../routes/agents/helpers', () => ({
  getOrgEventLogRetentionDays: (...args: unknown[]) => getOrgEventLogRetentionDaysMock(...(args as [])),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

import {
  __testOnly,
  createEventLogRetentionWorker,
  initializeEventLogRetention,
  shutdownEventLogRetention,
} from './eventLogRetention';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

/** Stub `db.select({...}).from(...)` to resolve to the given org rows. */
function stubOrgList(orgIds: string[]) {
  dbSelectMock.mockReturnValue({
    from: vi.fn().mockResolvedValue(orgIds.map((orgId) => ({ orgId }))),
  });
}

const renderedSql = () => JSON.stringify(dbExecuteMock.mock.calls);

describe('event log retention worker', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    addMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
    getOrgEventLogRetentionDaysMock.mockResolvedValue(30);
    stubOrgList([]);
    capturedWorkerProcessor.current = null;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await shutdownEventLogRetention();
    vi.restoreAllMocks();
  });

  // The headline fix: the org list must come from `organizations`, NOT from a
  // SELECT DISTINCT org_id scan across the whole device_event_logs table.
  it('reads the org list from organizations instead of scanning device_event_logs', async () => {
    stubOrgList([ORG_A]);
    createEventLogRetentionWorker();

    await capturedWorkerProcessor.current!({ data: {} });

    expect(dbSelectMock).toHaveBeenCalledTimes(1);
    // A DISTINCT scan would have been a selectDistinct() call, which this db
    // mock does not even expose — and no DELETE may target the log table via
    // a distinct subquery.
    expect(renderedSql()).not.toContain('DISTINCT');
  });

  it('prunes each org in bounded ctid batches scoped to that org', async () => {
    stubOrgList([ORG_A]);
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 10 })
      .mockResolvedValueOnce({ rowCount: 10 })
      .mockResolvedValueOnce({ rowCount: 3 });
    createEventLogRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { batchSize: 10, maxBatches: 20 },
    });

    // One SHORT context per read and per delete batch — never one spanning the
    // whole sweep, which would hold every lock until the last batch committed.
    // org list (1) + policy resolve (1) + 3 delete batches = 5.
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(5);
    const labels = withSystemDbAccessContextMock.mock.calls.map((call) => call[1]);
    expect(labels).toEqual([
      'eventLogRetention.orgList',
      'eventLogRetention.resolvePolicy',
      'eventLogRetention.prune',
      'eventLogRetention.prune',
      'eventLogRetention.prune',
    ]);
    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    const rendered = renderedSql();
    expect(rendered).toContain('DELETE FROM ');
    expect(rendered).toContain('device_event_logs');
    expect(rendered).toContain('SELECT ctid');
    expect(rendered).toContain('org_id = ');
    // `timestamp` is timestamptz on this table, unlike the sibling log tables.
    expect(rendered).toContain('::timestamptz');
    expect(rendered).toContain(ORG_A);
    expect(result).toMatchObject({ deleted: 23, orgsProcessed: 1, orgsPruned: 1, hasMore: false });
  });

  it('applies each org its own resolved retention window', async () => {
    stubOrgList([ORG_A, ORG_B]);
    getOrgEventLogRetentionDaysMock
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(90);
    createEventLogRetentionWorker();

    const result = await capturedWorkerProcessor.current!({ data: { batchSize: 100, maxBatches: 5 } });

    expect(getOrgEventLogRetentionDaysMock).toHaveBeenCalledWith(ORG_A);
    expect(getOrgEventLogRetentionDaysMock).toHaveBeenCalledWith(ORG_B);
    expect(result).toMatchObject({ orgsProcessed: 2, orgsPruned: 2 });
    // Two different cutoffs reached the driver, one per org.
    const cutoffs = dbExecuteMock.mock.calls.map((call) => {
      const chunks = JSON.stringify(call);
      return chunks.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
    });
    expect(new Set(cutoffs).size).toBe(2);
  });

  // Retaining too much is recoverable; deleting too early is not.
  it('skips an org whose retention cannot be resolved rather than pruning it', async () => {
    stubOrgList([ORG_A, ORG_B]);
    getOrgEventLogRetentionDaysMock
      .mockRejectedValueOnce(new Error('policy lookup exploded'))
      .mockResolvedValueOnce(30);
    createEventLogRetentionWorker();

    const result = await capturedWorkerProcessor.current!({ data: { batchSize: 100, maxBatches: 5 } });

    // A skipped org was never pruned, so its rows certainly remain — reporting
    // a clean drain here is the same misreport a failed org would cause.
    expect(result).toMatchObject({ orgsProcessed: 2, orgsPruned: 1, orgsSkipped: 1, hasMore: true });
    // Only the healthy org was touched.
    expect(renderedSql()).not.toContain(ORG_A);
    expect(renderedSql()).toContain(ORG_B);
  });

  // A corrupt/hand-edited policy row must not read as "delete everything" — the
  // validator bounds this field to 7..365.
  it('falls back to the default window when a policy returns a non-positive retention', async () => {
    stubOrgList([ORG_A]);
    getOrgEventLogRetentionDaysMock.mockResolvedValue(0);
    createEventLogRetentionWorker();

    const before = Date.now();
    await capturedWorkerProcessor.current!({ data: { batchSize: 100, maxBatches: 5 } });

    const cutoffIso = JSON.stringify(dbExecuteMock.mock.calls).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
    expect(cutoffIso).toBeTruthy();
    const ageDays = (before - new Date(cutoffIso!).getTime()) / 86_400_000;
    // ~30 days back, NOT ~0 (which would have pruned the org's entire history).
    expect(ageDays).toBeGreaterThan(__testOnly.FALLBACK_RETENTION_DAYS - 1);
    expect(ageDays).toBeLessThan(__testOnly.FALLBACK_RETENTION_DAYS + 1);
  });

  it('keeps pruning the remaining orgs when one org delete fails', async () => {
    stubOrgList([ORG_A, ORG_B]);
    dbExecuteMock
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce({ rowCount: 4 });
    createEventLogRetentionWorker();

    const result = await capturedWorkerProcessor.current!({ data: { batchSize: 100, maxBatches: 5 } });

    expect(result).toMatchObject({ orgsProcessed: 2, orgsFailed: 1, orgsPruned: 1, deleted: 4 });
  });

  // Without this the table grows unbounded while the job reports success nightly.
  it('stops at the per-org batch cap and warns loudly that a backlog remains', async () => {
    stubOrgList([ORG_A]);
    dbExecuteMock.mockResolvedValue({ rowCount: 10 });
    createEventLogRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { batchSize: 10, maxBatches: 3 },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ deleted: 30, hasMore: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(ORG_A);
  });

  it('registers the repeatable job with the batch bounds in its payload', async () => {
    await initializeEventLogRetention();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'eventLogRetention');
    expect(addMock).toHaveBeenCalledWith(
      'cleanup',
      expect.objectContaining({
        batchSize: __testOnly.BATCH_SIZE,
        maxBatches: __testOnly.MAX_BATCHES,
      }),
      expect.objectContaining({ repeat: expect.objectContaining({ pattern: expect.any(String) }) }),
    );
  });
});
