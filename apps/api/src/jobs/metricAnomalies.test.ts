import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getJobMock,
  addMock,
  addBulkMock,
  closeMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  attachWorkerObservabilityMock,
  selectMock,
  fromMock,
  whereMock,
  groupByMock,
  workerProcessorMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
} = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  groupByMock: vi.fn(),
  workerProcessorMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(<T>(fn: () => T) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = addBulkMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
    close = closeMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => unknown) {
      workerProcessorMock.mockImplementation(processor);
    }

    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn((state: string) => ['waiting', 'delayed', 'active'].includes(state)),
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../db/schema', () => ({
  devices: {},
}));

vi.mock('../services/metricAnomalies', () => ({
  detectMetricAnomaliesRange: vi.fn(),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

import {
  buildMetricAnomalyJobId,
  buildScheduledMetricAnomalyJobId,
  enqueueMetricAnomalyBackfill,
  initializeMetricAnomaliesWorker,
  shutdownMetricAnomaliesWorker,
} from './metricAnomalies';

/** The `detect-org-range` enqueues, excluding the `scan-orgs` repeatable. */
function detectAddCalls(): Array<[string, Record<string, unknown>, Record<string, unknown>]> {
  return addMock.mock.calls.filter(([name]) => name === 'detect-org-range') as Array<
    [string, Record<string, unknown>, Record<string, unknown>]
  >;
}

describe('metric anomalies queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    addBulkMock.mockReset();
    closeMock.mockReset();
    getRepeatableJobsMock.mockReset();
    removeRepeatableByKeyMock.mockReset();
    attachWorkerObservabilityMock.mockReset();
    selectMock.mockReset();
    fromMock.mockReset();
    whereMock.mockReset();
    groupByMock.mockReset();
    workerProcessorMock.mockReset();
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T) => fn());
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-anomaly-job' });
    addBulkMock.mockResolvedValue([]);
    getRepeatableJobsMock.mockResolvedValue([]);
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock });
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
    await shutdownMetricAnomaliesWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id per org and time range', async () => {
    const from = new Date('2026-06-18T11:00:00.000Z');
    const to = new Date('2026-06-18T12:00:00.000Z');
    const jobId = buildMetricAnomalyJobId('org-1', from, to);

    await enqueueMetricAnomalyBackfill({ orgId: 'org-1', from, to });

    expect(jobId).toBe('metric-anomalies-org-1-20260618T110000000Z-20260618T120000000Z');
    expect(addMock).toHaveBeenCalledWith(
      'detect-org-range',
      expect.objectContaining({
        type: 'detect-org-range',
        orgId: 'org-1',
        from: '2026-06-18T11:00:00.000Z',
        to: '2026-06-18T12:00:00.000Z',
      }),
      expect.objectContaining({ jobId }),
    );
  });

  it('reuses an existing queued backfill job for the same org and time range', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-anomaly-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await enqueueMetricAnomalyBackfill({
      orgId: 'org-1',
      from: new Date('2026-06-18T11:00:00.000Z'),
      to: new Date('2026-06-18T12:00:00.000Z'),
    });

    expect(jobId).toBe('existing-anomaly-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('attaches worker observability during initialization', async () => {
    await initializeMetricAnomaliesWorker();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'metricAnomaliesWorker');
    expect(addMock).toHaveBeenCalledWith(
      'scan-orgs',
      expect.objectContaining({ type: 'scan-orgs' }),
      expect.objectContaining({ jobId: 'metric-anomalies-scan-orgs' }),
    );
    const scanData = addMock.mock.calls.find(([name]) => name === 'scan-orgs')?.[1];
    expect(scanData).not.toHaveProperty('queuedAt');
  });

  it('uses the worker execution time when fan-out repeat scans create anomaly ranges', async () => {
    vi.setSystemTime(new Date('2026-06-18T12:01:00.000Z'));
    await initializeMetricAnomaliesWorker();
    addMock.mockClear();

    vi.setSystemTime(new Date('2026-06-18T12:26:10.000Z'));
    await workerProcessorMock({
      data: {
        type: 'scan-orgs',
        queuedAt: '2026-06-18T12:01:00.000Z',
        lookbackMinutes: 30,
      },
    });

    expect(detectAddCalls()).toHaveLength(1);
    const [, data, opts] = detectAddCalls()[0]!;
    expect(data).toMatchObject({
      orgId: 'org-1',
      from: '2026-06-18T11:55:00.000Z',
      to: '2026-06-18T12:25:00.000Z',
    });
    // The scheduled id carries NO window (#5283) — that is what lets BullMQ's
    // jobId dedup collapse a tick whose predecessor is still running.
    expect(opts).toMatchObject({ jobId: 'metric-anomalies-scheduled-org-1' });
  });

  it('does not hold system DB context while scan fan-out enqueues BullMQ jobs', async () => {
    const callOrder: string[] = [];
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T): T => {
      callOrder.push('runOutsideDbContext');
      return fn();
    });
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      callOrder.push('withSystemDbAccessContext:start');
      const result = await fn();
      callOrder.push('withSystemDbAccessContext:end');
      return result;
    });
    await initializeMetricAnomaliesWorker();
    // The repeatable `scan-orgs` add happens during init; only track the
    // per-org fan-out enqueues that follow.
    callOrder.length = 0;
    addMock.mockImplementation(async () => {
      callOrder.push('add');
      return { id: 'queued-anomaly-job' };
    });

    await workerProcessorMock({
      data: {
        type: 'scan-orgs',
        lookbackMinutes: 15,
      },
    });

    expect(callOrder).toEqual([
      'runOutsideDbContext',
      'withSystemDbAccessContext:start',
      'withSystemDbAccessContext:end',
      'add',
    ]);
  });

  // #5283: the scheduled fan-out kept the detection WINDOW in its job id, so
  // BullMQ's dedup never matched and every 10-minute tick stacked a fresh job
  // for an org whose previous run was still holding a transaction open.
  describe('scheduled overlap guard (#5283)', () => {
    it('uses a window-free per-org job id so consecutive ticks collapse instead of stacking', async () => {
      await initializeMetricAnomaliesWorker();

      addMock.mockClear();
      vi.setSystemTime(new Date('2026-06-18T12:00:30.000Z'));
      await workerProcessorMock({ data: { type: 'scan-orgs' } });
      const firstTick = detectAddCalls();

      addMock.mockClear();
      vi.setSystemTime(new Date('2026-06-18T12:10:30.000Z'));
      await workerProcessorMock({ data: { type: 'scan-orgs' } });
      const secondTick = detectAddCalls();

      // Same id across ticks — the property the old window-scoped id lacked.
      expect(firstTick[0]![2]).toMatchObject({ jobId: 'metric-anomalies-scheduled-org-1' });
      expect(secondTick[0]![2]).toMatchObject({ jobId: 'metric-anomalies-scheduled-org-1' });
      expect(buildScheduledMetricAnomalyJobId('org-1')).toBe('metric-anomalies-scheduled-org-1');
      // ...while the payload window still advances, so a job that DOES run
      // covers the current range rather than a frozen one.
      expect(firstTick[0]![1]).toMatchObject({ to: '2026-06-18T12:00:00.000Z' });
      expect(secondTick[0]![1]).toMatchObject({ to: '2026-06-18T12:10:00.000Z' });
    });

    it('reuses an in-flight scheduled job instead of enqueueing a second run for the same org', async () => {
      await initializeMetricAnomaliesWorker();
      addMock.mockClear();
      getJobMock.mockResolvedValue({
        id: 'metric-anomalies-scheduled-org-1',
        getState: vi.fn().mockResolvedValue('active'),
      });

      const result = await workerProcessorMock({ data: { type: 'scan-orgs' } });

      // The whole point: while the previous run is still executing, the tick
      // adds nothing. Before #5283 this enqueued a second job whose upsert then
      // waited on the first run's transactionid.
      expect(detectAddCalls()).toHaveLength(0);
      expect(result).toMatchObject({ queued: 0, reused: 1 });
    });

    it('replaces a spent scheduled record so a completed or failed run cannot wedge the org forever', async () => {
      await initializeMetricAnomaliesWorker();
      addMock.mockClear();
      const removeMock = vi.fn().mockResolvedValue(undefined);
      getJobMock.mockResolvedValue({
        id: 'metric-anomalies-scheduled-org-1',
        getState: vi.fn().mockResolvedValue('completed'),
        remove: removeMock,
      });

      const result = await workerProcessorMock({ data: { type: 'scan-orgs' } });

      // BullMQ's jobId dedup keys on "a record exists", not "a job is pending",
      // and removeOnComplete/removeOnFail RETAIN records — so a stable id
      // without this replacement would silently discard every tick after the
      // org's first run.
      expect(removeMock).toHaveBeenCalled();
      expect(detectAddCalls()).toHaveLength(1);
      expect(result).toMatchObject({ queued: 1, reused: 0 });
    });

    it('schedules a 15-minute lookback: one cron interval plus one bucket, so ticks overlap by exactly one bucket', async () => {
      await initializeMetricAnomaliesWorker();

      const scanData = addMock.mock.calls.find(([name]) => name === 'scan-orgs')?.[1] as
        | { lookbackMinutes?: number }
        | undefined;
      // 30 minutes on a 10-minute cron meant FOUR buckets of overlap, i.e. four
      // buckets' worth of identical ON CONFLICT keys contending every tick.
      expect(scanData?.lookbackMinutes).toBe(15);

      addMock.mockClear();
      vi.setSystemTime(new Date('2026-06-18T12:00:30.000Z'));
      await workerProcessorMock({ data: { type: 'scan-orgs', lookbackMinutes: scanData?.lookbackMinutes } });
      const first = detectAddCalls()[0]![1] as { from: string; to: string };

      addMock.mockClear();
      vi.setSystemTime(new Date('2026-06-18T12:10:30.000Z'));
      await workerProcessorMock({ data: { type: 'scan-orgs', lookbackMinutes: scanData?.lookbackMinutes } });
      const second = detectAddCalls()[0]![1] as { from: string; to: string };

      expect(first).toMatchObject({ from: '2026-06-18T11:45:00.000Z', to: '2026-06-18T12:00:00.000Z' });
      expect(second).toMatchObject({ from: '2026-06-18T11:55:00.000Z', to: '2026-06-18T12:10:00.000Z' });

      // Exactly one 5-minute bucket of overlap...
      const overlapMs = new Date(first.to).getTime() - new Date(second.from).getTime();
      expect(overlapMs).toBe(5 * 60 * 1000);
      // ...and no gap: the second window starts before the first one ends, so
      // no bucket falls between consecutive ticks.
      expect(new Date(second.from).getTime()).toBeLessThan(new Date(first.to).getTime());
    });
  });

  // Review follow-ups on #5283.
  describe('scan fan-out accounting (#5283 review)', () => {
    it('does not enqueue — and does not report a fresh queue — when a spent record cannot be removed', async () => {
      await initializeMetricAnomaliesWorker();
      addMock.mockClear();
      const removeMock = vi.fn().mockRejectedValue(new Error('redis unavailable'));
      getJobMock.mockResolvedValue({
        id: 'metric-anomalies-scheduled-org-1',
        getState: vi.fn().mockResolvedValue('completed'),
        remove: removeMock,
      });

      const result = await workerProcessorMock({ data: { type: 'scan-orgs' } });

      // BullMQ's addStandardJob checks `EXISTS jobIdKey` FIRST and takes the
      // duplicate path when the record is still there: it returns the id
      // without storing the payload or pushing onto the wait list. Calling
      // `add` anyway would be a total no-op reported as a successful enqueue,
      // so the org's window would silently go uncovered — the exact class of
      // invisible drop this PR exists to remove.
      expect(detectAddCalls()).toHaveLength(0);
      expect(result).toMatchObject({ queued: 0, reused: 0, staleRemoveFailed: 1 });
    });

    it('accounts each org separately across a multi-org fan-out', async () => {
      groupByMock.mockResolvedValue([{ orgId: 'org-1' }, { orgId: 'org-2' }]);
      await initializeMetricAnomaliesWorker();
      addMock.mockClear();
      // org-1 has a run in flight; org-2 is free.
      getJobMock.mockImplementation(async (jobId: string) =>
        jobId === 'metric-anomalies-scheduled-org-1'
          ? { id: jobId, getState: vi.fn().mockResolvedValue('active') }
          : null,
      );

      const result = await workerProcessorMock({ data: { type: 'scan-orgs' } });

      // One org's reuse must not be counted against the other's enqueue.
      expect(result).toMatchObject({ queued: 1, reused: 1, staleRemoveFailed: 0 });
      const enqueued = detectAddCalls();
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]![1]).toMatchObject({ orgId: 'org-2' });
      expect(enqueued[0]![2]).toMatchObject({ jobId: 'metric-anomalies-scheduled-org-2' });
    });
  });
});
