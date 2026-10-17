import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn();
const getRepeatableJobsMock = vi.fn();
const removeRepeatableByKeyMock = vi.fn();
const workerCtor = vi.fn();
const runDigestMock = vi.fn();
const attachMock = vi.fn();
const processor: { current?: () => Promise<unknown> } = {};

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...a: unknown[]) => addMock(...a);
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...a: unknown[]) => removeRepeatableByKeyMock(...a);
    close = vi.fn();
  },
  Worker: class {
    constructor(name: string, fn: () => Promise<unknown>, opts: unknown) {
      workerCtor(name, opts);
      processor.current = fn;
    }
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: (...a: unknown[]) => attachMock(...a) }));
vi.mock('../services/connectionHealth/digest', () => ({ runDigest: (...a: unknown[]) => runDigestMock(...a) }));

import {
  CONNECTION_HEALTH_DIGEST_QUEUE,
  initializeConnectionHealthDigestWorker,
  shutdownConnectionHealthDigestWorker,
} from './connectionHealthDigest';
import { jobSchedule } from './scheduleRegistry';

describe('connectionHealthDigest worker', () => {
  beforeEach(async () => {
    await shutdownConnectionHealthDigestWorker();
    vi.clearAllMocks();
    getRepeatableJobsMock.mockResolvedValue([]);
  });

  it('registers one consumer at concurrency 1 on the registry slot', async () => {
    await initializeConnectionHealthDigestWorker();
    expect(CONNECTION_HEALTH_DIGEST_QUEUE).toBe('connection-health-digest');
    expect(jobSchedule('connection-health-digest')).toBe('9 * * * *');
    expect(workerCtor).toHaveBeenCalledWith('connection-health-digest', expect.objectContaining({ concurrency: 1 }));
    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'connection-health-digest');
    expect(addMock).toHaveBeenCalledWith('digest', {}, expect.objectContaining({
      jobId: 'connection-health-digest',
      repeat: { pattern: '9 * * * *' },
    }));
  });

  it('removes a stale repeatable but keeps the current one', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { key: 'stale', id: 'connection-health-digest', pattern: '2 * * * *' },
      { key: 'current', id: 'connection-health-digest', pattern: '9 * * * *' },
    ]);
    await initializeConnectionHealthDigestWorker();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale');
  });

  it('the processor runs one digest pass and lets its failure fail the job', async () => {
    await initializeConnectionHealthDigestWorker();
    runDigestMock.mockResolvedValueOnce({ partners: 1, sent: 2 });
    await expect(processor.current!()).resolves.toEqual({ partners: 1, sent: 2 });
    runDigestMock.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(processor.current!()).rejects.toThrow('pool exhausted');
    expect(runDigestMock).toHaveBeenCalledTimes(2);
  });
});
