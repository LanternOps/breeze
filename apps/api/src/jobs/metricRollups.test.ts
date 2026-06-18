import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock, getRepeatableJobsMock, removeRepeatableByKeyMock, attachWorkerObservabilityMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
    close = closeMock;
  },
  Worker: class {
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
  db: {},
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
}));

vi.mock('../services/metricRollups', () => ({
  rollupDeviceMetricsRange: vi.fn(),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

import {
  buildMetricRollupJobId,
  enqueueMetricRollupBackfill,
  initializeMetricRollupsWorker,
  shutdownMetricRollupsWorker,
} from './metricRollups';

describe('metric rollups queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getRepeatableJobsMock.mockReset();
    removeRepeatableByKeyMock.mockReset();
    attachWorkerObservabilityMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-rollup-job' });
    getRepeatableJobsMock.mockResolvedValue([]);
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
  });
});
