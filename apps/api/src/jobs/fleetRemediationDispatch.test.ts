import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addBulkMock,
  upsertJobSchedulerMock,
  removeJobSchedulerMock,
  closeMock,
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
  addBulkMock: vi.fn(),
  upsertJobSchedulerMock: vi.fn(),
  removeJobSchedulerMock: vi.fn(),
  closeMock: vi.fn(),
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
    addBulk = addBulkMock;
    upsertJobScheduler = upsertJobSchedulerMock;
    removeJobScheduler = removeJobSchedulerMock;
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
    addBulkMock.mockReset();
    upsertJobSchedulerMock.mockReset();
    removeJobSchedulerMock.mockReset();
    closeMock.mockReset();
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
    addBulkMock.mockResolvedValue([]);
    upsertJobSchedulerMock.mockResolvedValue({ id: 'scheduled-job' });
    removeJobSchedulerMock.mockResolvedValue(true);
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
      expect(upsertJobSchedulerMock).not.toHaveBeenCalled();
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

    it('upserts a poll-run job scheduler every 30s keyed by fleet-run-poll-<runId>', async () => {
      await enqueueRemediationDispatch(RUN_1, 10);

      expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
        buildPollRunJobId(RUN_1),
        { every: 30_000 },
        expect.objectContaining({
          name: 'poll-run',
          data: expect.objectContaining({ type: 'poll-run', runId: RUN_1 }),
        })
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
      expect(removeJobSchedulerMock).not.toHaveBeenCalled();
    });

    it('removes the job scheduler by its own id once the run reaches a terminal status', async () => {
      await scheduleFleetRemediationDispatchJobs();
      limitMock.mockResolvedValue([{ status: 'succeeded' }]);
      isTerminalRunStatusMock.mockReturnValue(true);

      await workerProcessorMock({ data: { type: 'poll-run', runId: RUN_1 } });

      expect(removeJobSchedulerMock).toHaveBeenCalledTimes(1);
      expect(removeJobSchedulerMock).toHaveBeenCalledWith(buildPollRunJobId(RUN_1));
    });

    it('does not remove the job scheduler when the run is not found', async () => {
      await scheduleFleetRemediationDispatchJobs();
      limitMock.mockResolvedValue([]);

      await workerProcessorMock({ data: { type: 'poll-run', runId: RUN_1 } });

      expect(removeJobSchedulerMock).not.toHaveBeenCalled();
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
