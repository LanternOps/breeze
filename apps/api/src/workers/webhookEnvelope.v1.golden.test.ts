import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedisConnection: vi.fn(), createBlockingRedisConnection: vi.fn() }));
vi.mock('../db', () => ({ db: { select: vi.fn() }, withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('../services/urlSafety', async () => ({ ...await vi.importActual('../services/urlSafety'), safeFetch: safeFetchMock }));
import { deliverWebhook, type WebhookDeliveryJob } from './webhookDelivery';
const dir = new URL('./__fixtures__/webhookV1/', import.meta.url);
const fixtures = readdirSync(dir).sort().map(name => JSON.parse(readFileSync(new URL(name, dir), 'utf8')));
describe('v1 wire golden fixtures', () => {
  beforeEach(() => { vi.clearAllMocks(); safeFetchMock.mockResolvedValue(new Response('ok')); });
  it.each(fixtures)('today’s deliverWebhook preserves $event.type bytes', async ({ event, expectedBody }) => {
    const job = {
      id: 'delivery-1', webhookId: 'webhook-1', attempts: 0, createdAt: event.timestamp,
      webhook: { id: 'webhook-1', orgId: event.orgId, name: 'Golden', url: 'https://hooks.example.com/events', events: ['*'] },
      event: { id: event.id, type: event.type, orgId: event.orgId, payload: event.data, metadata: { timestamp: event.timestamp } },
    } as WebhookDeliveryJob;
    expect((await deliverWebhook(job)).success).toBe(true);
    expect(safeFetchMock.mock.calls[0]![1].body).toBe(expectedBody);
  });
});

it.each(fixtures)('v1 envelope preserves $event.type golden bytes', async ({ event, expectedBody }) => {
  const { buildWebhookEnvelope } = await import('../services/webhookPayload/envelope');
  expect(buildWebhookEnvelope({ version: 1, ...event, replayOf: null })).toBe(expectedBody);
});
