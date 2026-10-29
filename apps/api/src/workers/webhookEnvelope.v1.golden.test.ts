import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { safeFetchMock, selectMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn(), selectMock: vi.fn() }));
vi.mock('../db', () => ({ db: { select: selectMock }, withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('../services/urlSafety', async () => ({ ...await vi.importActual('../services/urlSafety'), safeFetch: safeFetchMock }));
vi.mock('../services/webhookConfig', () => ({ toWebhookConfig: (row: unknown) => row }));
import { deliverWebhook, type WebhookDeliveryJob } from './webhookDelivery';
const dir = new URL('./__fixtures__/webhookV1/', import.meta.url);
const fixtures = readdirSync(dir).sort().map(name => JSON.parse(readFileSync(new URL(name, dir), 'utf8')));
describe('v1 wire golden fixtures', () => {
  beforeEach(() => { vi.clearAllMocks(); safeFetchMock.mockResolvedValue(new Response('ok')); });
  it.each(fixtures)('today’s deliverWebhook preserves $event.type bytes', async ({ event, expectedBody }) => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'webhook-1', orgId: event.orgId, status: 'active', name: 'Golden', url: 'https://hooks.example.com/events', events: ['*'] }] }) }) });
    const job = {
      id: 'delivery-1', webhookId: 'webhook-1', attempts: 0,
      event: { id: event.id, type: event.type, payload: event.data, timestamp: event.timestamp },
    } as WebhookDeliveryJob;
    expect((await deliverWebhook(job)).success).toBe(true);
    expect(safeFetchMock.mock.calls[0]![1].body).toBe(expectedBody);
  });
  it.each(fixtures)('v1 replay preserves $event.type golden bytes and identifies its root', async ({ event, expectedBody }) => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'webhook-1', orgId: event.orgId, status: 'active', name: 'Golden', url: 'https://hooks.example.com/events', events: ['*'] }] }) }) });
    const job = {
      id: 'delivery-1', webhookId: 'webhook-1', attempts: 0,
      payloadVersion: 1, replayOf: 'root-event',
      event: { id: event.id, type: event.type, payload: event.data, timestamp: event.timestamp },
    } as WebhookDeliveryJob;
    expect((await deliverWebhook(job)).success).toBe(true);
    const request = safeFetchMock.mock.calls[0]![1];
    expect(request.body).toBe(expectedBody);
    expect(request.headers['X-Breeze-Replay-Of']).toBe('root-event');
  });

});

it.each(fixtures)('v1 envelope preserves $event.type golden bytes', async ({ event, expectedBody }) => {
  const { buildWebhookEnvelope } = await import('../services/webhookPayload/envelope');
  expect(buildWebhookEnvelope({ version: 1, ...event, replayOf: null })).toBe(expectedBody);
});
