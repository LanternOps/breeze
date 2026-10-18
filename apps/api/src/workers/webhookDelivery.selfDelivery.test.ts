import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spec 2026-10-15 §9 W5: a connection health event about a webhook is never
// delivered to that same webhook (feedback loop), and still reaches the others.

const queueDeliveryMock = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({
  createBlockingRedisConnection: () => ({}),
  getRedisConnection: () => ({}),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { configureWebhookFanout, handleWebhookFanoutEvent, getWebhookWorker } from './webhookDelivery';

const SELF = { id: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', orgId: 'org-1', approvalGeneration: 1 };
const OTHER = { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', orgId: 'org-1', approvalGeneration: 1 };

const event = (type: string, payload: Record<string, unknown>) => ({
  id: 'event-1',
  type,
  orgId: 'org-1',
  source: 'connection-health',
  priority: 'normal' as const,
  payload,
  metadata: { correlationId: 'c1', timestamp: new Date().toISOString() },
});

describe('webhook fan-out: connection health self-delivery exclusion', () => {
  const createDeliveryRecord = vi.fn(async (w: { id: string }) => ({ created: true as const, deliveryId: `d-${w.id}` }));

  beforeEach(() => {
    queueDeliveryMock.mockReset();
    createDeliveryRecord.mockClear();
    vi.spyOn(getWebhookWorker(), 'queueDelivery').mockImplementation(queueDeliveryMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    configureWebhookFanout({ getWebhooksForEvent: async () => [SELF, OTHER], createDeliveryRecord });
  });
  afterEach(() => vi.restoreAllMocks());

  const queuedTo = () => queueDeliveryMock.mock.calls.map((c) => c[0]);

  it.each(['integration.health_opened', 'integration.health_resolved'])(
    '%s about a webhook skips that webhook before any delivery row, and still reaches the others',
    async (type) => {
      await handleWebhookFanoutEvent(event(type, { sourceKind: 'webhook', sourceId: SELF.id }) as never);
      expect(queuedTo()).toEqual([OTHER.id]);
      expect(createDeliveryRecord.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([OTHER.id]);
    },
  );

  it('a health event about another kind of connection reaches every subscribed webhook', async () => {
    await handleWebhookFanoutEvent(event('integration.health_opened', { sourceKind: 'm365_sync', sourceId: SELF.id }) as never);
    expect(queuedTo()).toEqual([SELF.id, OTHER.id]);
  });

  it('a non-health event carrying the same fields is never filtered', async () => {
    await handleWebhookFanoutEvent(event('alert.triggered', { sourceKind: 'webhook', sourceId: SELF.id }) as never);
    expect(queuedTo()).toEqual([SELF.id, OTHER.id]);
  });
});
