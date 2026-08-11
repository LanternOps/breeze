import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { queueAdd, getRepeatableJobs, removeRepeatableByKey, WorkerMockCtor } = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  getRepeatableJobs: vi.fn().mockResolvedValue([
    { name: 'abuse-sweep', key: 'old-key-1' },
    { name: 'unrelated', key: 'other' },
  ]),
  removeRepeatableByKey: vi.fn(),
  WorkerMockCtor: vi.fn(function WorkerMock() {
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock('bullmq', () => ({
  // Function expressions (not arrow functions) so `new Queue()` /
  // `new Worker()` are constructible under vitest's mock implementation
  // (mirrors the pattern in jobs/peripheralJobs.test.ts).
  Queue: vi.fn(function QueueMock() {
    return { add: queueAdd, getRepeatableJobs, removeRepeatableByKey, close: vi.fn() };
  }),
  Worker: WorkerMockCtor,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/abuseSignals', () => ({ runAbuseSweep: vi.fn(), runAbuseDigest: vi.fn() }));
vi.mock('../services/abuseMetrics', () => ({ recordAbuseSweepRun: vi.fn() }));

import {
  scheduleAbuseSignalsJobs,
  createAbuseSignalsWorker,
  initializeAbuseSignalsWorker,
  shutdownAbuseSignalsWorker,
} from './abuseSignalsSweep';
import { runAbuseSweep, runAbuseDigest } from '../services/abuseSignals';
import { recordAbuseSweepRun } from '../services/abuseMetrics';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.IS_HOSTED;
  delete process.env.ABUSE_SIGNALS_ENABLED;
});

afterEach(async () => {
  await shutdownAbuseSignalsWorker();
  delete process.env.IS_HOSTED;
  delete process.env.ABUSE_SIGNALS_ENABLED;
});

/** Pulls the processor function (2nd constructor arg) passed to `new Worker(...)`. */
function getProcessor(): (job: { name: string }) => Promise<unknown> {
  createAbuseSignalsWorker();
  const calls = WorkerMockCtor.mock.calls as unknown as Array<[unknown, (job: { name: string }) => Promise<unknown>]>;
  const call = calls[calls.length - 1];
  if (!call) throw new Error('Worker constructor was not called');
  return call[1];
}

describe('scheduleAbuseSignalsJobs', () => {
  it('clears prior repeatables for its own job names only, then schedules hourly sweep + weekly digest', async () => {
    getRepeatableJobs.mockResolvedValueOnce([
      { name: 'abuse-sweep', key: 'stale-sweep' },
      { name: 'abuse-digest', key: 'stale-digest' },
      { name: 'unrelated', key: 'other' },
    ]);
    await scheduleAbuseSignalsJobs();
    expect(removeRepeatableByKey).toHaveBeenCalledWith('stale-sweep');
    expect(removeRepeatableByKey).toHaveBeenCalledWith('stale-digest');
    expect(removeRepeatableByKey).not.toHaveBeenCalledWith('other');
    expect(queueAdd).toHaveBeenCalledWith(
      'abuse-sweep',
      expect.anything(),
      expect.objectContaining({ jobId: 'abuse-sweep-repeat', repeat: { every: 60 * 60 * 1000 } }),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'abuse-digest',
      expect.anything(),
      expect.objectContaining({ jobId: 'abuse-digest-repeat', repeat: { pattern: '0 9 * * 1' } }),
    );
  });
});

describe('abuse signals worker processor', () => {
  it('records a success metric scoped to the sweep job', async () => {
    vi.mocked(runAbuseSweep).mockResolvedValueOnce({ fired: 3, notified: 1 });
    const processor = getProcessor();

    const result = await processor({ name: 'abuse-sweep' });

    expect(result).toEqual({ fired: 3, notified: 1 });
    expect(recordAbuseSweepRun).toHaveBeenCalledWith('success');
    expect(recordAbuseSweepRun).toHaveBeenCalledTimes(1);
  });

  it('records an error metric scoped to the sweep job and rethrows when runAbuseSweep rejects', async () => {
    const sweepError = new Error('sweep blew up');
    vi.mocked(runAbuseSweep).mockRejectedValueOnce(sweepError);
    const processor = getProcessor();

    await expect(processor({ name: 'abuse-sweep' })).rejects.toThrow(sweepError);
    expect(recordAbuseSweepRun).toHaveBeenCalledWith('error');
    expect(recordAbuseSweepRun).toHaveBeenCalledTimes(1);
  });

  it('does not touch the sweep metric when the digest job throws', async () => {
    const digestError = new Error('digest delivery failed');
    vi.mocked(runAbuseDigest).mockRejectedValueOnce(digestError);
    const processor = getProcessor();

    await expect(processor({ name: 'abuse-digest' })).rejects.toThrow(digestError);
    expect(recordAbuseSweepRun).not.toHaveBeenCalled();
  });

  it('resolves and warns for an unknown job name', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = getProcessor();

    const result = await processor({ name: 'some-other-job' });

    expect(result).toEqual({});
    expect(recordAbuseSweepRun).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('some-other-job'));
    warnSpy.mockRestore();
  });
});

describe('initializeAbuseSignalsWorker gating', () => {
  it('starts the worker and schedules jobs when hosted', async () => {
    process.env.IS_HOSTED = 'true';
    await initializeAbuseSignalsWorker();
    expect(WorkerMockCtor).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });

  it('does not start a worker or schedule anything when self-hosted', async () => {
    process.env.IS_HOSTED = 'false';
    await initializeAbuseSignalsWorker();
    expect(WorkerMockCtor).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('stays off when IS_HOSTED is unset, so an unconfigured install is never surprised by it', async () => {
    await initializeAbuseSignalsWorker();
    expect(WorkerMockCtor).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('clears repeatables a previous boot registered, so a disabled sweep really stops', async () => {
    process.env.IS_HOSTED = 'false';
    await initializeAbuseSignalsWorker();
    // Only this queue's own job names; 'unrelated' in the fixture is left alone.
    expect(removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKey).toHaveBeenCalledWith('old-key-1');
  });

  it('does not take the API down when Redis is unreachable during teardown', async () => {
    process.env.IS_HOSTED = 'false';
    getRepeatableJobs.mockRejectedValueOnce(new Error('redis down'));
    await expect(initializeAbuseSignalsWorker()).resolves.toBeUndefined();
    expect(WorkerMockCtor).not.toHaveBeenCalled();
  });

  it('lets a self-hoster opt in explicitly', async () => {
    process.env.IS_HOSTED = 'false';
    process.env.ABUSE_SIGNALS_ENABLED = 'true';
    await initializeAbuseSignalsWorker();
    expect(WorkerMockCtor).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });

  it('lets a hosted deployment opt out explicitly', async () => {
    process.env.IS_HOSTED = 'true';
    process.env.ABUSE_SIGNALS_ENABLED = 'false';
    await initializeAbuseSignalsWorker();
    expect(WorkerMockCtor).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
