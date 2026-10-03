import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined),
  work: vi.fn(), dispatch: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  expiry: vi.fn(),
  drain: vi.fn().mockResolvedValue(undefined), observe: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class { add = mocks.add; close = mocks.close; },
  Worker: class { constructor(name: string, processor: unknown) { mocks.work(name, processor); } on() { return this; } close = mocks.close; },
}));
vi.mock('../services/autopay/reminderSweep', () => ({ runInvoiceReminderSweep: vi.fn() }));
vi.mock('../services/autopay/cardExpiryCheck', () => ({ checkExpiringAutopayCards: mocks.expiry }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/autopay/noticeOutbox', () => ({ dispatchPendingBillingNotices: mocks.dispatch }));
vi.mock('../services/autopay/merge', () => ({ drainAutopayMethodDetaches: mocks.drain }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.observe }));
import { initializeAutopayWorkers, shutdownAutopayWorkers, processNoticeDispatch, processAutopayJob } from './autopayWorker';
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
    expect(jobSchedule('autopay-card-expiry-check')).toBe('28 6 * * *');
    expect(mocks.add).toHaveBeenCalledTimes(3);
    expect(mocks.add).toHaveBeenCalledWith('card-expiry-check', { type: 'card-expiry-check' }, expect.objectContaining({
      jobId: 'autopay-card-expiry-check', repeat: { pattern: '28 6 * * *', tz: 'UTC' },
    }));
    const processor = mocks.work.mock.calls.at(-1)?.[1] as (job: { data: { type: string }; name: string }) => Promise<unknown>;
    expect(await processor({ data: { type: 'notice-dispatch' }, name: 'notice-dispatch' })).toEqual({ sent: 1, failed: 0 });
    await expect(processor({ data: { type: 'unexpected' }, name: 'unexpected' })).rejects.toThrow('Unknown autopay job: unexpected');
    expect(await processNoticeDispatch()).toEqual({ sent: 1, failed: 0 });
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.drain).toHaveBeenCalledTimes(2);
    await shutdownAutopayWorkers();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it('closes partial resources and retries initialization when schedule registration fails', async () => {
    mocks.add.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(initializeAutopayWorkers()).rejects.toThrow('redis unavailable');
    expect(mocks.close).toHaveBeenCalledTimes(2);

    await expect(initializeAutopayWorkers()).resolves.toBeUndefined();
    expect(mocks.add).toHaveBeenCalledTimes(4);
    await shutdownAutopayWorkers();
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

it('retains dispatch counts when detach drain fails', async () => {
  mocks.drain.mockRejectedValueOnce(new Error('detach database down'));
  await expect(processNoticeDispatch()).resolves.toEqual({ sent: 1, failed: 0 });
});
it('still drains when dispatch fails and surfaces failed counts', async () => {
  mocks.dispatch.mockRejectedValueOnce(new Error('dispatch database down'));
  await expect(processNoticeDispatch()).rejects.toThrow('dispatch database down');
  expect(mocks.drain).toHaveBeenCalledOnce();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.dispatch.mockResolvedValueOnce({ sent: 0, failed: 2 });
  expect(await processNoticeDispatch()).toEqual({ sent: 0, failed: 2 });
  expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ failed: 2 }));
  log.mockRestore();
});

it('dispatches expiry without consuming notice dispatch', async () => {
  mocks.expiry.mockResolvedValue({ enqueued: 2 });
  mocks.dispatch.mockResolvedValueOnce({ sent: 3, failed: 0 });
  expect(await processAutopayJob({ type: 'card-expiry-check' })).toEqual({ enqueued: 2 });
  expect(await processAutopayJob({ type: 'notice-dispatch' })).toEqual({ sent: 3, failed: 0 });
  expect(mocks.expiry).toHaveBeenCalledOnce();
  expect(mocks.dispatch).toHaveBeenCalledOnce();
});
it('cleans up and retries when the expiry schedule fails', async () => {
  mocks.add.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('expiry registration failed'));
  await expect(initializeAutopayWorkers()).rejects.toThrow('expiry registration failed');
  expect(mocks.close).toHaveBeenCalledTimes(2);
  await expect(initializeAutopayWorkers()).resolves.toBeUndefined();
  expect(mocks.add).toHaveBeenCalledTimes(5);
  await shutdownAutopayWorkers();
});

it('cleans up and retries when the reminder schedule fails', async () => {
  mocks.add.mockResolvedValueOnce({}).mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error('reminder registration failed'));
  try {
    await expect(initializeAutopayWorkers()).rejects.toThrow('reminder registration failed');
    expect(mocks.close).toHaveBeenCalledTimes(2);
    await expect(initializeAutopayWorkers()).resolves.toBeUndefined();
    expect(mocks.add).toHaveBeenCalledTimes(6);
    await initializeAutopayWorkers();
    expect(mocks.add).toHaveBeenCalledTimes(6);
  } finally {
    await shutdownAutopayWorkers();
  }
  expect(mocks.close).toHaveBeenCalledTimes(4);
});
