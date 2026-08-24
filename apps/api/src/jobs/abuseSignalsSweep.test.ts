import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { queueAdd, getRepeatableJobs, removeRepeatableByKey, queueClose, QueueMockCtor, WorkerMockCtor } =
  vi.hoisted(() => {
    const queueAddFn = vi.fn();
    const getRepeatableJobsFn = vi.fn().mockResolvedValue([
      { name: 'abuse-sweep', key: 'old-key-1' },
      { name: 'unrelated', key: 'other' },
    ]);
    const removeRepeatableByKeyFn = vi.fn();
    // Hoisted (not inlined into the constructor) so tests can assert that
    // `queue.close()` actually fired on the disable path.
    const queueCloseFn = vi.fn();
    return {
      queueAdd: queueAddFn,
      getRepeatableJobs: getRepeatableJobsFn,
      removeRepeatableByKey: removeRepeatableByKeyFn,
      queueClose: queueCloseFn,
      // Function expressions (not arrow functions) so `new Queue()` /
      // `new Worker()` are constructible under vitest's mock implementation
      // (mirrors the pattern in jobs/peripheralJobs.test.ts).
      QueueMockCtor: vi.fn(function QueueMock() {
        return {
          add: queueAddFn,
          getRepeatableJobs: getRepeatableJobsFn,
          removeRepeatableByKey: removeRepeatableByKeyFn,
          close: queueCloseFn,
        };
      }),
      WorkerMockCtor: vi.fn(function WorkerMock() {
        return { on: vi.fn(), close: vi.fn() };
      }),
    };
  });

vi.mock('bullmq', () => ({
  Queue: QueueMockCtor,
  Worker: WorkerMockCtor,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/abuseSignals', () => ({ runAbuseSweep: vi.fn(), runAbuseDigest: vi.fn() }));
vi.mock('../services/abuseMetrics', () => ({ recordAbuseSweepRun: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import {
  scheduleAbuseSignalsJobs,
  createAbuseSignalsWorker,
  initializeAbuseSignalsWorker,
  shutdownAbuseSignalsWorker,
  getAbuseSignalsQueue,
} from './abuseSignalsSweep';
import { runAbuseSweep, runAbuseDigest } from '../services/abuseSignals';
import { recordAbuseSweepRun } from '../services/abuseMetrics';
import { captureException } from '../services/sentry';

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
      expect.objectContaining({ jobId: 'abuse-sweep-repeat', repeat: { pattern: '22 * * * *' } }),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'abuse-digest',
      expect.anything(),
      expect.objectContaining({ jobId: 'abuse-digest-repeat', repeat: { pattern: '18 9 * * 1' } }),
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

  it('names the values it actually read instead of blaming a self-hosted default', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await initializeAbuseSignalsWorker();
    const disabledLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('Disabled'));
    expect(disabledLine).toBeDefined();
    // An unmapped IS_HOSTED on a hosted box (#570) must not be reported as a
    // self-hosted default — the line reports the readings, not a cause.
    expect(disabledLine).not.toContain('self-hosted default');
    expect(disabledLine).toContain('IS_HOSTED=<unset>');
    expect(disabledLine).toContain('ABUSE_SIGNALS_ENABLED=<unset>');
    logSpy.mockRestore();
  });
});

describe('initializeAbuseSignalsWorker teardown gating', () => {
  it('leaves shared repeat keys alone when off by default, so one mis-configured replica cannot unschedule a healthy sibling', async () => {
    process.env.IS_HOSTED = 'false';
    await initializeAbuseSignalsWorker();
    expect(removeRepeatableByKey).not.toHaveBeenCalled();
    // Never even touches the queue — nothing to construct or close.
    expect(QueueMockCtor).not.toHaveBeenCalled();
    expect(queueClose).not.toHaveBeenCalled();
  });

  it('leaves repeat keys alone when IS_HOSTED is unset (the #570 unmapped-env shape)', async () => {
    await initializeAbuseSignalsWorker();
    expect(removeRepeatableByKey).not.toHaveBeenCalled();
    expect(QueueMockCtor).not.toHaveBeenCalled();
  });

  it('removes repeat keys and closes the queue when the operator explicitly opted out', async () => {
    process.env.ABUSE_SIGNALS_ENABLED = 'off';
    await initializeAbuseSignalsWorker();
    // Only this queue's own job names; 'unrelated' in the fixture is left alone.
    expect(removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKey).toHaveBeenCalledWith('old-key-1');
    expect(queueClose).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('drops the queue handle after a successful close, so the next caller gets a fresh Queue', async () => {
    process.env.ABUSE_SIGNALS_ENABLED = 'false';
    await initializeAbuseSignalsWorker();
    expect(QueueMockCtor).toHaveBeenCalledTimes(1);
    getAbuseSignalsQueue();
    expect(QueueMockCtor).toHaveBeenCalledTimes(2);
  });

  it('reports to Sentry instead of swallowing silently when Redis is unreachable during teardown', async () => {
    process.env.ABUSE_SIGNALS_ENABLED = 'false';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const redisError = new Error('redis down');
    getRepeatableJobs.mockRejectedValueOnce(redisError);

    // Still resolves: an inert subsystem must not fail worker init.
    await expect(initializeAbuseSignalsWorker()).resolves.toBeUndefined();

    expect(WorkerMockCtor).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[AbuseSignals]'), redisError);
    expect(captureException).toHaveBeenCalledWith(redisError);
    errorSpy.mockRestore();
  });

  it('still closes the queue and frees the handle when clearing repeatables throws', async () => {
    process.env.ABUSE_SIGNALS_ENABLED = 'false';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getRepeatableJobs.mockRejectedValueOnce(new Error('redis down'));

    await initializeAbuseSignalsWorker();

    expect(queueClose).toHaveBeenCalledTimes(1);
    expect(QueueMockCtor).toHaveBeenCalledTimes(1);
    getAbuseSignalsQueue();
    expect(QueueMockCtor).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('keeps the queue handle when close() itself fails, so shutdown can still reach it', async () => {
    process.env.ABUSE_SIGNALS_ENABLED = 'false';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeError = new Error('close failed');
    queueClose.mockRejectedValueOnce(closeError);

    await initializeAbuseSignalsWorker();

    expect(captureException).toHaveBeenCalledWith(closeError);
    // Handle retained (not orphaned): the same Queue is reused, no new construction.
    expect(QueueMockCtor).toHaveBeenCalledTimes(1);
    getAbuseSignalsQueue();
    expect(QueueMockCtor).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
