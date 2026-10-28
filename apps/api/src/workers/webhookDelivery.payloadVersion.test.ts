import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ enrich: vi.fn(), fetch: vi.fn(), push: vi.fn(), pop: vi.fn(), index: vi.fn(), remove: vi.fn() }));
vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../services/redis', () => ({
  getRedisConnection: () => ({ lpush: mocks.push, lindex: mocks.index, lrem: mocks.remove }),
  createBlockingRedisConnection: () => ({ brpop: mocks.pop, status: 'ready' }),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/webhookPayload/alertEnrichment', () => ({ buildAlertWebhookProjections: mocks.enrich }));
vi.mock('../services/urlSafety', async () => ({ ...await vi.importActual('../services/urlSafety'), safeFetch: mocks.fetch }));
import { configureWebhookFanout, handleWebhookFanoutEvent, getWebhookWorker, deliverWebhook, type WebhookDeliveryJob } from './webhookDelivery';
import type { BreezeEvent } from '../services/eventBus';
const event: BreezeEvent = { id: 'event-1', type: 'alert.triggered', orgId: 'org-1', source: 'test', priority: 'normal', payload: { alertId: 'alert-1' }, metadata: { timestamp: '2026-10-28T12:00:00.000Z' } };
const org = Object.freeze({ alertId: 'alert-1', status: 'active' });
function target(id: string, payloadVersion: 1 | 2) { return { id, orgId: 'org-1', approvalGeneration: 1, payloadVersion }; }
function job(extra: Partial<WebhookDeliveryJob> = {}): WebhookDeliveryJob {
  return { id: 'delivery-1', webhookId: 'hook-1', event, attempts: 0, createdAt: event.metadata.timestamp,
    webhook: { id: 'hook-1', orgId: 'org-1', name: 'Hook', url: 'https://hooks.example.com', secret: 'secret', events: ['*'] }, ...extra };
}
beforeEach(() => { vi.clearAllMocks(); mocks.enrich.mockResolvedValue({ org, partner: { ...org, orgExternalIds: [] } }); mocks.fetch.mockResolvedValue(new Response('ok')); });
afterEach(() => vi.restoreAllMocks());
describe('per-delivery payload version', () => {
  it.each([{ versions: [1] }, { versions: [1, 2, 2] }] as const)('enriches lazily once for targets $versions', async ({ versions }) => {
    const targets = versions.map((v, i) => target(`hook-${i}`, v));
    const record = vi.fn(async () => ({ created: true as const, deliveryId: 'delivery-1' }));
    const queue = vi.spyOn(getWebhookWorker(), 'queueDelivery').mockResolvedValue('delivery-1');
    configureWebhookFanout({ getWebhooksForEvent: async () => targets, createDeliveryRecord: record });
    await handleWebhookFanoutEvent(event);
    expect(mocks.enrich).toHaveBeenCalledTimes(versions.some(version => version === 2) ? 1 : 0);
    versions.forEach((v, i) => {
      const expectedEvent = v === 2 ? { ...event, payload: org } : event;
      expect(record).toHaveBeenNthCalledWith(i + 1, targets[i], expectedEvent);
      expect(queue).toHaveBeenNthCalledWith(i + 1, targets[i]!.id, 1, expectedEvent, 'delivery-1', { payloadVersion: v, replayOf: null });
    });
    expect(event.payload).toEqual({ alertId: 'alert-1' });
  });
  it.each(['alert.correlation_group.created', 'device.offline'] as const)('does not enrich %s', async type => {
    const queue = vi.spyOn(getWebhookWorker(), 'queueDelivery').mockResolvedValue('delivery-1');
    configureWebhookFanout({ getWebhooksForEvent: async () => [target('hook-1', 2)] });
    const rawEvent = { ...event, type };
    await handleWebhookFanoutEvent(rawEvent);
    expect(mocks.enrich).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledWith('hook-1', 1, rawEvent, undefined, { payloadVersion: 2, replayOf: null });
  });
  it.each([undefined, 1, 2] as const)('signs the actual body for version %s and carries replay headers', async payloadVersion => {
    await deliverWebhook(job({ payloadVersion, replayOf: 'original-id' }));
    const { body, headers } = mocks.fetch.mock.calls[0]![1];
    const parsed = JSON.parse(body);
    expect(parsed.schemaVersion).toBe(payloadVersion === 2 ? 2 : undefined);
    expect(parsed.replayOf).toBe(payloadVersion === 2 ? 'original-id' : undefined);
    expect(headers['X-Breeze-Replay-Of']).toBe('original-id');
    expect(headers['X-Breeze-Signature']).toBe('sha256=' + createHmac('sha256', 'secret').update(headers['X-Breeze-Signature-Timestamp'] + '.' + body).digest('hex'));
  });
  it('persists wire identity on the queue and in-process retry', async () => {
    const worker = getWebhookWorker();
    await worker.queueDelivery('hook-1', 1, event, 'delivery-1', { payloadVersion: 2, replayOf: 'root' });
    expect(JSON.parse(mocks.push.mock.calls[0]![1])).toMatchObject({ payloadVersion: 2, replayOf: 'root' });
    mocks.push.mockClear();
    mocks.pop.mockResolvedValue(['queue', JSON.stringify(job({ payloadVersion: 2, replayOf: 'root' }))]);
    mocks.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await (worker as unknown as { processNextJob(): Promise<void> }).processNextJob();
    expect(JSON.parse(mocks.push.mock.calls[0]![1])).toMatchObject({ payloadVersion: 2, replayOf: 'root', attempts: 1 });
  });
  it('preserves wire identity when replaying a DLQ job', async () => {
    mocks.index.mockResolvedValue(JSON.stringify({ job: job({ payloadVersion: 2, replayOf: 'root' }) }));
    await getWebhookWorker().retryFromDLQ(0);
    expect(JSON.parse(mocks.push.mock.calls[0]![1])).toMatchObject({ payloadVersion: 2, replayOf: 'root' });
  });
});
