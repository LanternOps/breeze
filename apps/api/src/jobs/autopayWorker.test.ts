import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined),
  work: vi.fn(), dispatch: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  drain: vi.fn().mockResolvedValue(undefined), observe: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class { add = mocks.add; close = mocks.close; },
  Worker: class { constructor(name: string, processor: unknown) { mocks.work(name, processor); } on() { return this; } close = mocks.close; },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/autopay/noticeOutbox', () => ({ dispatchPendingBillingNotices: mocks.dispatch }));
vi.mock('../services/autopay/merge', () => ({ drainAutopayMethodDetaches: mocks.drain }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.observe }));
import { initializeAutopayWorkers, shutdownAutopayWorkers, processNoticeDispatch } from './autopayWorker';
import { jobSchedule } from './scheduleRegistry';
import { WORKER_REGISTRY, selectWorkers } from '../services/workerRegistry';
import { WORKER_READINESS_MANIFEST } from './workerReadinessManifest';
beforeEach(() => vi.clearAllMocks());
describe('autopay worker registration', () => {
  it('registers precisely the C5 cadence and closes both resources', async () => {
    expect(jobSchedule('billing-notice-dispatch')).toBe('* * * * *');
    await initializeAutopayWorkers();
    expect(mocks.work).toHaveBeenCalledWith('autopay-jobs', expect.any(Function));
    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.observe).toHaveBeenCalledWith(expect.anything(), 'autopayWorker');
    expect(mocks.add).toHaveBeenCalledWith('notice-dispatch', { type: 'notice-dispatch' }, expect.objectContaining({
      jobId: 'billing-notice-dispatch', repeat: { pattern: '* * * * *', tz: 'UTC' },
    }));
    expect(await processNoticeDispatch()).toEqual({ sent: 1, failed: 0 });
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.drain).toHaveBeenCalledOnce();
    await shutdownAutopayWorkers();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it('is selected by the real worker registry and actual entrypoint uses that registry', () => {
    const entry = WORKER_REGISTRY.find(e => e.name === 'autopayWorker');
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker')).toContain(entry);
    const entrypoint = readFileSync(new URL('../worker.ts', import.meta.url), 'utf8');
    expect(entrypoint).toContain("await import('./services/workerRegistry')");
    expect(entrypoint).toContain("startRegisteredWorkers('worker'");
  });
  it('declares exactly one Redis-required consumer for later waves', () => {
    expect(WORKER_READINESS_MANIFEST.filter(entry => entry.initializer === 'autopayWorker')).toEqual([{
      kind: 'consumers', initializer: 'autopayWorker',
      consumers: ['autopayWorker'], requiredWhen: 'redis',
    }]);
  });
  it('propagates dispatcher failure so BullMQ records it', async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error('database down'));
    await expect(processNoticeDispatch()).rejects.toThrow('database down');
  });
});
