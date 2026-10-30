import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  queue: { getJob: vi.fn(), add: vi.fn(), close: vi.fn() },
}));
vi.mock('../services/bullmqQueue', () => ({ createInstrumentedQueue: vi.fn(() => mocks.queue) }));
vi.mock('../services/bullmqUtils', async (original) => {
  const real = await original<typeof import('../services/bullmqUtils')>();
  return { ...real, enqueueOrReplaceStale: vi.fn(real.enqueueOrReplaceStale) };
});
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { webhookAttemptJobDataSchema } from './queueSchemas';
import { closeWebhookDeliveryQueue, enqueueWebhookAttempt, getWebhookDeliveryQueue, webhookAttemptJobId, WEBHOOK_DELIVERY_QUEUE, WEBHOOK_ATTEMPT_JOB_NAME } from './webhookDeliveryQueue';
const data = { deliveryId: '00000000-0000-4000-8000-000000000001', webhookId: '00000000-0000-4000-8000-000000000002', generation: 2, attemptsMade: 3 };
const now = new Date('2027-01-12T00:00:00Z');
describe('webhook attempt queue', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); mocks.queue.getJob.mockResolvedValue(null); mocks.queue.add.mockImplementation(async (_name, _payload, opts) => ({ id: opts.jobId })); });
  afterEach(async () => { await closeWebhookDeliveryQueue(); vi.useRealTimers(); });
  it('enqueues exactly the ids and attempt with bounded BullMQ retries', async () => {
    const id = await enqueueWebhookAttempt({ ...data, secret: 'never serialize' } as typeof data, new Date(+now + 90_000));
    expect(id).toBe(`webhook-attempt-${data.deliveryId}-3`);
    expect(id).not.toContain(':');
    expect(webhookAttemptJobId(data.deliveryId, 3)).toBe(id);
    expect(WEBHOOK_DELIVERY_QUEUE).toBe('webhook-delivery');
    expect(WEBHOOK_ATTEMPT_JOB_NAME).toBe('webhook-attempt');
    expect(enqueueOrReplaceStale).toHaveBeenCalledWith(mocks.queue, 'webhook-attempt', id, data, {
      delay: 90_000, attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: { count: 200 }, removeOnFail: { count: 500 },
    }, '[WebhookDeliveryQueue]');
  });
  it('clamps past runAt to zero', async () => {
    await enqueueWebhookAttempt(data, new Date(+now - 1));
    expect(mocks.queue.add.mock.calls[0]![2].delay).toBe(0);
  });
  it('reuses a live job', async () => {
    mocks.queue.getJob.mockResolvedValue({ id: webhookAttemptJobId(data.deliveryId, 3), getState: async () => 'delayed' });
    await enqueueWebhookAttempt(data, now);
    expect(mocks.queue.add).not.toHaveBeenCalled();
  });
  it('replaces a completed job', async () => {
    const remove = vi.fn();
    mocks.queue.getJob.mockResolvedValue({ getState: async () => 'completed', remove: remove.mockResolvedValue(undefined) });
    await enqueueWebhookAttempt(data, now);
    expect(remove).toHaveBeenCalledOnce(); expect(mocks.queue.add).toHaveBeenCalledOnce();
  });
  it('creates the queue lazily once and closes it', async () => {
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
    expect(getWebhookDeliveryQueue()).toBe(getWebhookDeliveryQueue());
    expect(createInstrumentedQueue).toHaveBeenCalledExactlyOnceWith('webhook-delivery');
    await closeWebhookDeliveryQueue(); expect(mocks.queue.close).toHaveBeenCalledOnce();
  });
  it('strictly validates the ids-only schema', () => {
    expect(webhookAttemptJobDataSchema.parse(data)).toEqual(data);
    for (const invalid of [{ ...data, url: 'secret' }, { ...data, attemptsMade: -1 }, { ...data, generation: 0.5 }, { ...data, deliveryId: 'bad' }]) {
      expect(webhookAttemptJobDataSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
