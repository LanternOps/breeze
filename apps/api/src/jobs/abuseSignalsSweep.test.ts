import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { scheduleAbuseSignalsJobs, createAbuseSignalsWorker } from './abuseSignalsSweep';
import { runAbuseSweep, runAbuseDigest } from '../services/abuseSignals';
import { recordAbuseSweepRun } from '../services/abuseMetrics';

beforeEach(() => vi.clearAllMocks());

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
