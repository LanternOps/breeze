import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscribeMock = vi.hoisted(() => vi.fn());
const queueDeliveryMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../services/eventBus', () => ({
  getEventBus: () => ({ subscribe: subscribeMock }),
  EVENT_TYPES: {}
}));

vi.mock('../db', () => ({
  db: {},
  // webhookDelivery.ts:12 builds its own runWithSystemDbAccess around this
  // export; keep it a pass-through so the subscriber body actually runs.
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn()
}));

vi.mock('../services/redis', () => ({
  createBlockingRedisConnection: () => ({}),
  getRedisConnection: () => ({})
}));

import { initializeWebhookDelivery, getWebhookWorker } from './webhookDelivery';

const EVENT = {
  id: 'event-1',
  type: 'alert.triggered',
  orgId: 'org-1',
  source: 'test',
  priority: 'normal' as const,
  payload: {},
  metadata: { correlationId: 'c1', timestamp: new Date().toISOString() }
};

const WEBHOOK = { id: 'webhook-1', orgId: 'org-1', url: 'https://example.test/hook' };

describe('webhook delivery is one-per-(webhook, event)', () => {
  let handler: (event: typeof EVENT) => Promise<void>;

  beforeEach(async () => {
    subscribeMock.mockReset();
    queueDeliveryMock.mockReset();
    vi.spyOn(getWebhookWorker(), 'queueDelivery').mockImplementation(queueDeliveryMock);
    vi.spyOn(getWebhookWorker(), 'start').mockImplementation(startMock);
  });

  it('does not queue a second delivery when the (webhook, event) pair is already recorded', async () => {
    const createDeliveryRecord = vi.fn()
      .mockResolvedValueOnce('delivery-1')   // first: this call won the insert
      .mockResolvedValueOnce(null);          // redelivery: unique index rejected it

    await initializeWebhookDelivery(async () => [WEBHOOK] as never, createDeliveryRecord as never);
    handler = subscribeMock.mock.calls[0]![1];

    await handler(EVENT);
    await handler(EVENT);

    // Two attempts, one outbound POST: the customer's endpoint must not be
    // hit twice for one event.
    expect(createDeliveryRecord).toHaveBeenCalledTimes(2);
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('still queues blind when no delivery-record creator is configured', async () => {
    await initializeWebhookDelivery(async () => [WEBHOOK] as never);
    handler = subscribeMock.mock.calls[0]![1];

    await handler(EVENT);

    // No creator means no dedupe surface exists; skipping here would drop the
    // delivery entirely rather than de-duplicate it.
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });
});
