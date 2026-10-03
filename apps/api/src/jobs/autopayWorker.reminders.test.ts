import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  sweep: vi.fn(), add: vi.fn(), repeat: vi.fn(), remove: vi.fn(), close: vi.fn(),
  processor: null as null | ((job: { data: { type: string } }) => Promise<unknown>),
  queueNames: [] as string[], workerNames: [] as string[],
}));
vi.mock('../services/autopay/reminderSweep', () => ({ runInvoiceReminderSweep: mocks.sweep }));
vi.mock('../services/redis', async original => ({
  ...(await original<typeof import('../services/redis')>()), getBullMQConnection: () => ({}),
}));
vi.mock('../services/autopay/cardExpiryCheck', () => ({ checkExpiringAutopayCards: vi.fn() }));
vi.mock('../services/autopay/noticeOutbox', () => ({ dispatchPendingBillingNotices: vi.fn() }));
vi.mock('../services/autopay/merge', () => ({ drainAutopayMethodDetaches: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string) { mocks.queueNames.push(name); }
    add = mocks.add; getRepeatableJobs = mocks.repeat; removeRepeatableByKey = mocks.remove; close = mocks.close;
  },
  Worker: class {
    constructor(name: string, processor: typeof mocks.processor) {
      mocks.workerNames.push(name); mocks.processor = processor;
    }
    on = vi.fn().mockReturnThis(); close = mocks.close;
  },
}));
import { initializeAutopayWorkers, shutdownAutopayWorkers } from './autopayWorker';
import { jobSchedule } from './scheduleRegistry';

beforeEach(() => {
  vi.clearAllMocks(); mocks.queueNames.length = 0; mocks.workerNames.length = 0;
  mocks.repeat.mockResolvedValue([]); mocks.add.mockResolvedValue({ id: 'job' });
  mocks.close.mockResolvedValue(undefined); mocks.sweep.mockResolvedValue({ enqueued: 2 });
});
describe('reminder job', () => {
  it('registers 06:18 on autopay-jobs and routes the actual worker processor', async () => {
    try {
      await initializeAutopayWorkers();
      expect(mocks.queueNames).toContain('autopay-jobs');
      expect(mocks.workerNames).toContain('autopay-jobs');
      expect(jobSchedule('invoice-overdue-sweep')).toBe('8 6 * * *');
      expect(jobSchedule('invoice-reminder-sweep')).toBe('18 6 * * *');
      expect(mocks.add).toHaveBeenCalledWith('reminder-sweep', { type: 'reminder-sweep' },
        expect.objectContaining({ jobId: 'invoice-reminder-sweep', repeat: { pattern: '18 6 * * *', tz: 'UTC' }, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } }));
      await expect(mocks.processor!({ data: { type: 'reminder-sweep' } })).resolves.toEqual({ enqueued: 2 });
      expect(mocks.sweep).toHaveBeenCalledOnce();
      mocks.sweep.mockRejectedValue(new Error('sweep unavailable'));
      await expect(mocks.processor!({ data: { type: 'reminder-sweep' } })).rejects.toThrow('sweep unavailable');
    } finally { await shutdownAutopayWorkers(); }
  });
});
