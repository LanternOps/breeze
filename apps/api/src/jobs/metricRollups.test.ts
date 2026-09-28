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
  rollupDeviceMetricsRangeMock,
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
  rollupDeviceMetricsRangeMock: vi.fn(),
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

vi.mock('../services/metricRollups', () => ({
  rollupDeviceMetricsRange: rollupDeviceMetricsRangeMock,
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

import {
  buildMetricRollupJobId,
  enqueueMetricRollupBackfill,
  initializeMetricRollupsWorker,
  scheduledDayRollups,
  shutdownMetricRollupsWorker,
} from './metricRollups';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('metric rollups queue helpers', () => {
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
    rollupDeviceMetricsRangeMock.mockReset();
    rollupDeviceMetricsRangeMock.mockResolvedValue({ statements: 9, skipped: false });
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T) => fn());
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-rollup-job' });
    addBulkMock.mockResolvedValue([]);
    getRepeatableJobsMock.mockResolvedValue([]);
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock });
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
    await shutdownMetricRollupsWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id per org and time range', async () => {
    const from = new Date('2026-06-18T11:00:00.000Z');
    const to = new Date('2026-06-18T12:00:00.000Z');
    const jobId = buildMetricRollupJobId('org-1', from, to);

    await enqueueMetricRollupBackfill({ orgId: 'org-1', from, to });

    expect(jobId).toBe('metric-rollups-org-1-20260618T110000000Z-20260618T120000000Z');
    expect(addMock).toHaveBeenCalledWith(
      'rollup-org-range',
      expect.objectContaining({
        type: 'rollup-org-range',
        orgId: 'org-1',
        from: '2026-06-18T11:00:00.000Z',
        to: '2026-06-18T12:00:00.000Z',
      }),
      expect.objectContaining({ jobId }),
    );
  });

  it('reuses an existing queued backfill job for the same org and time range', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-rollup-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await enqueueMetricRollupBackfill({
      orgId: 'org-1',
      from: new Date('2026-06-18T11:00:00.000Z'),
      to: new Date('2026-06-18T12:00:00.000Z'),
    });

    expect(jobId).toBe('existing-rollup-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('attaches worker observability during initialization', async () => {
    await initializeMetricRollupsWorker();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'metricRollupsWorker');
    expect(addMock).toHaveBeenCalledWith(
      'scan-orgs',
      expect.objectContaining({ type: 'scan-orgs' }),
      expect.objectContaining({ jobId: 'metric-rollups-scan-orgs' }),
    );
    const scanData = addMock.mock.calls.find(([name]) => name === 'scan-orgs')?.[1];
    expect(scanData).not.toHaveProperty('queuedAt');
  });

  it('uses the worker execution time when fan-out repeat scans create rollup ranges', async () => {
    vi.setSystemTime(new Date('2026-06-18T12:01:00.000Z'));
    await initializeMetricRollupsWorker();
    addBulkMock.mockClear();

    vi.setSystemTime(new Date('2026-06-18T12:26:10.000Z'));
    await workerProcessorMock({
      data: {
        type: 'scan-orgs',
        queuedAt: '2026-06-18T12:01:00.000Z',
        lookbackMinutes: 15,
      },
    });

    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'rollup-org-range',
        data: expect.objectContaining({
          orgId: 'org-1',
          from: '2026-06-18T12:10:00.000Z',
          to: '2026-06-18T12:25:00.000Z',
          queuedAt: '2026-06-18T12:26:10.000Z',
        }),
        opts: expect.objectContaining({
          jobId: 'metric-rollups-org-1-20260618T121000000Z-20260618T122500000Z',
        }),
      }),
    ]);
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
    addBulkMock.mockImplementation(async () => {
      callOrder.push('addBulk');
      return [];
    });

    await initializeMetricRollupsWorker();
    addBulkMock.mockClear();
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
      'addBulk',
    ]);
  });

  // #4276 — under the tsup single-file bundle every anonymous-arrow opener in
  // the API collapses to a bare `index` in `parseOpenerFrame`, so an unlabelled
  // context arrives in Sentry unattributed. The worker tag alone was doing all
  // the attribution work for this queue's holds.
  it('labels the scan-orgs system context for Sentry attribution', async () => {
    await initializeMetricRollupsWorker();
    withSystemDbAccessContextMock.mockClear();

    await workerProcessorMock({ data: { type: 'scan-orgs', lookbackMinutes: 15 } });

    expect(withSystemDbAccessContextMock).toHaveBeenCalledWith(
      expect.any(Function),
      'metricRollups.scanOrgs',
    );
  });

  // #4276 — the worker used to wrap ALL of rollupDeviceMetricsRange in one
  // system context, pinning a pooled connection across every sequential
  // statement of the pass for 2s+ every 5 minutes. The service now owns one short-lived context per
  // statement; a wrap here would make each of those short-circuit back into a
  // single transaction and silently restore the hold (the alertWorker/#3216
  // trap).
  it('does not wrap rollup-org-range in a worker-level system DB context', async () => {
    await initializeMetricRollupsWorker();
    withSystemDbAccessContextMock.mockClear();
    runOutsideDbContextMock.mockClear();

    await workerProcessorMock({
      data: {
        type: 'rollup-org-range',
        orgId: 'org-1',
        from: '2026-06-18T12:00:00.000Z',
        to: '2026-06-18T12:15:00.000Z',
        queuedAt: '2026-06-18T12:15:00.000Z',
      },
    });

    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(rollupDeviceMetricsRangeMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:15:00.000Z'),
    });
  });
});

// #4276 direction 1 — the hour→day derived passes re-aggregate a whole UTC day
// of hourly rows, so running them on every 5-minute run made each org's pass
// O(hours elapsed today). The scheduler now runs them on ONE run per hour, with
// a catch-up lookback so late data at a day boundary is still folded in.
describe('metric rollups day-level schedule (#4276)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    getRepeatableJobsMock.mockReset();
    getRepeatableJobsMock.mockResolvedValue([]);
    getJobMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockReset();
    addMock.mockResolvedValue({ id: 'queued-rollup-job' });
    addBulkMock.mockReset();
    addBulkMock.mockResolvedValue([]);
    selectMock.mockReset();
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReset();
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReset();
    whereMock.mockReturnValue({ groupBy: groupByMock });
    groupByMock.mockReset();
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
    rollupDeviceMetricsRangeMock.mockReset();
    rollupDeviceMetricsRangeMock.mockResolvedValue({ statements: 6, skipped: false });
    await shutdownMetricRollupsWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function scanAt(now: string): Promise<Record<string, unknown>> {
    await initializeMetricRollupsWorker();
    addBulkMock.mockClear();
    vi.setSystemTime(new Date(now));
    await workerProcessorMock({ data: { type: 'scan-orgs', lookbackMinutes: 15 } });
    const [jobs] = addBulkMock.mock.calls[0] as [Array<{ data: Record<string, unknown> }>];
    return (jobs[0] as { data: Record<string, unknown> }).data;
  }

  it('skips the day passes on the eleven non-day runs of each hour', async () => {
    const data = await scanAt('2026-06-18T12:26:10.000Z');
    expect(data).toMatchObject({ to: '2026-06-18T12:25:00.000Z', dayRollups: 'skip' });
  });

  it('runs the day passes on the :15 run, reaching back three hours before the raw window', async () => {
    const data = await scanAt('2026-06-18T12:15:20.000Z');
    expect(data).toMatchObject({
      from: '2026-06-18T12:00:00.000Z',
      to: '2026-06-18T12:15:00.000Z',
      dayRollups: { from: '2026-06-18T09:00:00.000Z' },
    });
  });

  it('hands the day window to the service as a Date, and passes skip through', async () => {
    await initializeMetricRollupsWorker();
    const base = {
      type: 'rollup-org-range',
      orgId: 'org-1',
      from: '2026-06-19T00:00:00.000Z',
      to: '2026-06-19T00:15:00.000Z',
      queuedAt: '2026-06-19T00:15:00.000Z',
    };

    await workerProcessorMock({ data: { ...base, dayRollups: { from: '2026-06-18T21:00:00.000Z' } } });
    expect(rollupDeviceMetricsRangeMock).toHaveBeenLastCalledWith({
      orgId: 'org-1',
      from: new Date('2026-06-19T00:00:00.000Z'),
      to: new Date('2026-06-19T00:15:00.000Z'),
      dayRollups: { from: new Date('2026-06-18T21:00:00.000Z') },
    });

    await workerProcessorMock({ data: { ...base, dayRollups: 'skip' } });
    expect(rollupDeviceMetricsRangeMock).toHaveBeenLastCalledWith(expect.objectContaining({ dayRollups: 'skip' }));
  });

  it('leaves the day passes at the service default for backfills', async () => {
    await enqueueMetricRollupBackfill({
      orgId: 'org-1',
      from: new Date('2026-06-18T00:00:00.000Z'),
      to: new Date('2026-06-19T00:00:00.000Z'),
    });
    expect(addMock.mock.calls[0]?.[1]).not.toHaveProperty('dayRollups');
  });

  // The correctness property the schedule exists to keep. A run with window
  // [T-15m, T) rewrites the hourly rollups of every hour it overlaps (the hour
  // pass expands to hour bounds). Each such hour's DAY bucket must be re-derived
  // by a day run at or after T — even when the next two day runs are lost
  // (deploy, Redis blip) — or the day bucket silently keeps a stale value. The
  // walk spans midnight, where the previous day's last hour is still changing
  // on the 00:05 and 00:10 runs of the next day.
  it('re-folds every hour a run touches into its day, across midnight, surviving two missed day runs', () => {
    const FIVE_MIN = 5 * 60 * 1000;
    const start = Date.parse('2026-06-18T20:00:00.000Z');
    const end = Date.parse('2026-06-19T05:00:00.000Z');

    const dayRun = (t: number) => {
      const plan = scheduledDayRollups({ from: new Date(t - 15 * 60 * 1000), to: new Date(t) });
      return plan === 'skip' ? null : { from: plan.from.getTime(), to: t };
    };
    const dayRunTimes: number[] = [];
    for (let t = start; t < end + 4 * HOUR_MS; t += FIVE_MIN) if (dayRun(t)) dayRunTimes.push(t);
    // Exactly one day run per hour — the whole point of the change.
    expect(dayRunTimes).toHaveLength((end + 4 * HOUR_MS - start) / HOUR_MS);

    for (let t = start; t <= end; t += FIVE_MIN) {
      const windowFrom = t - 15 * 60 * 1000;
      const touchedHours: number[] = [];
      for (let h = Math.floor(windowFrom / HOUR_MS) * HOUR_MS; h < t; h += HOUR_MS) touchedHours.push(h);

      // Two lost day runs: the third one at/after T must still cover.
      const survivor = dayRunTimes.filter((r) => r >= t)[2] as number;
      const plan = dayRun(survivor);
      if (!plan) throw new Error('expected a day run');
      const coveredFrom = Math.floor(plan.from / DAY_MS) * DAY_MS;
      const coveredTo = Math.ceil(plan.to / DAY_MS) * DAY_MS;
      for (const hour of touchedHours) {
        const day = Math.floor(hour / DAY_MS) * DAY_MS;
        expect(
          day >= coveredFrom && day < coveredTo,
          `hour ${new Date(hour).toISOString()} touched at ${new Date(t).toISOString()} is not re-folded by the day run at ${new Date(survivor).toISOString()}`,
        ).toBe(true);
      }
    }
  });
});
