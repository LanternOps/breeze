import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  addBulkMock,
  closeMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  attachWorkerObservabilityMock,
  workerProcessorMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  dispatchRunChunkMock,
  pollRunProgressMock,
  isTerminalRunStatusMock,
  selectMock,
  fromMock,
  whereMock,
  limitMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  workerProcessorMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(<T>(fn: () => T) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dispatchRunChunkMock: vi.fn(),
  pollRunProgressMock: vi.fn(),
  isTerminalRunStatusMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
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

vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../db/schema/fleetFindings', () => ({
  fleetRemediationRuns: { id: 'frr.id', status: 'frr.status' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
}));

vi.mock('../services/fleetFindings/dispatch', () => ({
  dispatchRunChunk: dispatchRunChunkMock,
  pollRunProgress: pollRunProgressMock,
  isTerminalRunStatus: isTerminalRunStatusMock,
  REMEDIATION_CHUNK_SIZE: 500,
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

import {
  buildDispatchChunkJobId,
  buildPollRunJobId,
  enqueueRemediationDispatch,
  scheduleFleetRemediationDispatchJobs,
  shutdownFleetRemediationDispatchJobs,
} from './fleetRemediationDispatch';

const RUN_1 = 'ee111111-1111-4111-8111-111111111111';

describe('fleet remediation dispatch job helpers', () => {
  beforeEach(async () => {
    addMock.mockReset();
    addBulkMock.mockReset();
    closeMock.mockReset();
    getRepeatableJobsMock.mockReset();
    removeRepeatableByKeyMock.mockReset();
    attachWorkerObservabilityMock.mockReset();
    workerProcessorMock.mockReset();
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T) => fn());
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    dispatchRunChunkMock.mockReset().mockResolvedValue(undefined);
    pollRunProgressMock.mockReset().mockResolvedValue(undefined);
    isTerminalRunStatusMock.mockReset().mockReturnValue(false);
    selectMock.mockReset();
    fromMock.mockReset();
    whereMock.mockReset();
    limitMock.mockReset();
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ limit: limitMock });
    limitMock.mockResolvedValue([{ status: 'running' }]);
    addMock.mockResolvedValue({ id: 'queued-job' });
    addBulkMock.mockResolvedValue([]);
    getRepeatableJobsMock.mockResolvedValue([]);
    await shutdownFleetRemediationDispatchJobs();
  });

  it('builds dispatch-chunk and poll-run job ids with no colons', () => {
    expect(buildDispatchChunkJobId(RUN_1, 2)).toBe(`fleet-run-dispatch-${RUN_1}-2`);
    expect(buildDispatchChunkJobId(RUN_1, 2)).not.toContain(':');
    expect(buildPollRunJobId(RUN_1)).toBe(`fleet-run-poll-${RUN_1}`);
    expect(buildPollRunJobId(RUN_1)).not.toContain(':');
  });

  describe('enqueueRemediationDispatch', () => {
    it('is a no-op when targetCount is 0', async () => {
      await enqueueRemediationDispatch(RUN_1, 0);
      expect(addBulkMock).not.toHaveBeenCalled();
      expect(addMock).not.toHaveBeenCalled();
    });

    it('splits 1200 targets into exactly 3 dispatch-chunk jobs', async () => {
      await enqueueRemediationDispatch(RUN_1, 1200);

      expect(addBulkMock).toHaveBeenCalledTimes(1);
      const jobs = addBulkMock.mock.calls[0]![0] as Array<{ data: { chunkIndex: number }; opts: { jobId: string } }>;
      expect(jobs).toHaveLength(3);
      expect(jobs.map((j) => j.data.chunkIndex)).toEqual([0, 1, 2]);
      expect(jobs.map((j) => j.opts.jobId)).toEqual([
        buildDispatchChunkJobId(RUN_1, 0),
        buildDispatchChunkJobId(RUN_1, 1),
        buildDispatchChunkJobId(RUN_1, 2),
      ]);
    });

    it('splits exactly 500 targets into a single chunk (boundary)', async () => {
      await enqueueRemediationDispatch(RUN_1, 500);
      const jobs = addBulkMock.mock.calls[0]![0] as unknown[];
      expect(jobs).toHaveLength(1);
    });

    it('splits 501 targets into 2 chunks (boundary + 1)', async () => {
      await enqueueRemediationDispatch(RUN_1, 501);
      const jobs = addBulkMock.mock.calls[0]![0] as unknown[];
      expect(jobs).toHaveLength(2);
    });

    it('enqueues a repeatable poll-run job every 30s with jobId fleet-run-poll-<runId>', async () => {
      await enqueueRemediationDispatch(RUN_1, 10);

      expect(addMock).toHaveBeenCalledWith(
        'poll-run',
        expect.objectContaining({ type: 'poll-run', runId: RUN_1 }),
        expect.objectContaining({ jobId: buildPollRunJobId(RUN_1), repeat: { every: 30_000 } })
      );
    });
  });

  describe('worker processor', () => {
    it('dispatches a chunk inside a system DB context established outside the request context', async () => {
      await scheduleFleetRemediationDispatchJobs();

      await workerProcessorMock({ data: { type: 'dispatch-chunk', runId: RUN_1, chunkIndex: 1 } });

      expect(runOutsideDbContextMock).toHaveBeenCalled();
      expect(withSystemDbAccessContextMock).toHaveBeenCalled();
      expect(dispatchRunChunkMock).toHaveBeenCalledWith(RUN_1, 1);
    });

    it('polls run progress inside a system DB context, then re-checks status', async () => {
      await scheduleFleetRemediationDispatchJobs();
      limitMock.mockResolvedValue([{ status: 'running' }]);
      isTerminalRunStatusMock.mockReturnValue(false);

      await workerProcessorMock({ data: { type: 'poll-run', runId: RUN_1 } });

      expect(pollRunProgressMock).toHaveBeenCalledWith(RUN_1);
      expect(removeRepeatableByKeyMock).not.toHaveBeenCalled();
    });

    it('removes the repeatable poll job once the run reaches a terminal status', async () => {
      await scheduleFleetRemediationDispatchJobs();
      limitMock.mockResolvedValue([{ status: 'succeeded' }]);
      isTerminalRunStatusMock.mockReturnValue(true);
      getRepeatableJobsMock.mockResolvedValue([
        { id: buildPollRunJobId(RUN_1), key: 'repeat-key-1', name: 'poll-run' },
        { id: buildPollRunJobId('other-run'), key: 'repeat-key-2', name: 'poll-run' },
      ]);

      await workerProcessorMock({ data: { type: 'poll-run', runId: RUN_1 } });

      expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('repeat-key-1');
    });

    it('does not remove any repeatable job when the run is not found', async () => {
      await scheduleFleetRemediationDispatchJobs();
      limitMock.mockResolvedValue([]);

      await workerProcessorMock({ data: { type: 'poll-run', runId: RUN_1 } });

      expect(removeRepeatableByKeyMock).not.toHaveBeenCalled();
    });
  });

  it('attaches worker observability and logs init', async () => {
    await scheduleFleetRemediationDispatchJobs();
    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'fleetRemediationDispatchWorker');
  });

  it('shuts down cleanly (closes worker + queue)', async () => {
    await scheduleFleetRemediationDispatchJobs();
    await enqueueRemediationDispatch(RUN_1, 10); // instantiate the queue too
    await shutdownFleetRemediationDispatchJobs();
    expect(closeMock).toHaveBeenCalled();
  });
});
