import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn();
const getRepeatableJobsMock = vi.fn();
const removeRepeatableByKeyMock = vi.fn();
const workerCtor = vi.fn();
const runReconcileMock = vi.fn();
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
vi.mock('../services/connectionHealth/reconcile', () => ({ runReconcile: (...a: unknown[]) => runReconcileMock(...a) }));

import {
  CONNECTION_HEALTH_QUEUE,
  initializeConnectionHealthReconcileWorker,
  shutdownConnectionHealthReconcileWorker,
} from './connectionHealthReconcile';

describe('connectionHealthReconcile worker', () => {
  beforeEach(async () => {
    await shutdownConnectionHealthReconcileWorker();
    vi.clearAllMocks();
    getRepeatableJobsMock.mockResolvedValue([]);
  });

  it('registers one consumer at concurrency 1 and the stable 15-minute repeatable', async () => {
    await initializeConnectionHealthReconcileWorker();
    expect(CONNECTION_HEALTH_QUEUE).toBe('connection-health-reconcile');
    expect(workerCtor).toHaveBeenCalledWith('connection-health-reconcile', expect.objectContaining({ concurrency: 1 }));
    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'connection-health-reconcile');
    expect(addMock).toHaveBeenCalledWith('reconcile', {}, expect.objectContaining({
      jobId: 'connection-health-reconcile',
      repeat: { pattern: '2,17,32,47 * * * *' },
    }));
  });

  it('removes a stale repeatable but keeps the current one', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { key: 'stale', id: 'connection-health-reconcile', pattern: '*/15 * * * *' },
      { key: 'current', id: 'connection-health-reconcile', pattern: '2,17,32,47 * * * *' },
    ]);
    await initializeConnectionHealthReconcileWorker();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale');
  });

  it('the processor runs one reconcile and lets its failure fail the job', async () => {
    await initializeConnectionHealthReconcileWorker();
    runReconcileMock.mockResolvedValueOnce({ kinds: [{ kind: 'oauth_grant', status: 'ok' }], notices: { delivered: 1, failed: 0 }, retained: 0 });
    await expect(processor.current!()).resolves.toEqual({ kinds: [['oauth_grant', 'ok']], notices: { delivered: 1, failed: 0 }, retained: 0 });
    runReconcileMock.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(processor.current!()).rejects.toThrow('pool exhausted');
    expect(runReconcileMock).toHaveBeenCalledTimes(2);
  });
});
