import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ enrich: vi.fn(), fetch: vi.fn(), queue: vi.fn(), select: vi.fn() }));
vi.mock('../db', () => ({ db: { select: mocks.select }, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../jobs/webhookDeliveryQueue', () => ({ enqueueWebhookAttempt: mocks.queue }));
vi.mock('../services/webhookConfig', () => ({ toWebhookConfig: (row: unknown) => row }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/webhookPayload/alertEnrichment', () => ({ buildAlertWebhookProjections: mocks.enrich }));
vi.mock('../services/urlSafety', async () => ({ ...await vi.importActual('../services/urlSafety'), safeFetch: mocks.fetch }));
import { configureWebhookFanout, handleWebhookFanoutEvent, deliverWebhook, type WebhookDeliveryJob } from './webhookDelivery';
import type { BreezeEvent } from '../services/eventBus';
const event: BreezeEvent = { id: 'event-1', type: 'alert.triggered', orgId: 'org-1', source: 'test', priority: 'normal', payload: { alertId: 'alert-1' }, metadata: { timestamp: '2026-10-28T12:00:00.000Z' } };
const org = Object.freeze({ alertId: 'alert-1', status: 'active' });
function target(id: string, payloadVersion: 1 | 2) { return { id, orgId: 'org-1', partnerId: null, approvalGeneration: 1, payloadVersion }; }
function job(extra: Partial<WebhookDeliveryJob> = {}): WebhookDeliveryJob {
  return { orgId: 'org-1', id: 'delivery-1', webhookId: 'hook-1', generation: 1, payloadVersion: 1, event: { id: event.id, type: event.type, payload: event.payload, timestamp: event.metadata.timestamp }, attempts: 0, ...extra };
}
beforeEach(() => { vi.clearAllMocks(); mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'hook-1', status: 'active', approvalGeneration: 1, orgId: 'org-1', partnerId: null, name: 'Hook', url: 'https://hooks.example.com', secret: 'secret', events: ['*'] }] }) }) }); mocks.enrich.mockResolvedValue({ org, partner: { ...org, orgExternalIds: [] } }); mocks.fetch.mockResolvedValue(new Response('ok')); });
afterEach(() => vi.restoreAllMocks());
describe('per-delivery payload version', () => {
  it('still records and queues v1 when v2 enrichment rejects', async () => {
    const v1 = target('hook-v1', 1);
    const v2 = target('hook-v2', 2);
    mocks.enrich.mockRejectedValue(new Error('enrichment unavailable'));
    const record = vi.fn(async () => ({ created: true as const, deliveryId: 'delivery-v1' }));
    const queue = mocks.queue;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    configureWebhookFanout({ getWebhooksForEvent: async () => [v2, v1], createDeliveryRecord: record });
    await expect(handleWebhookFanoutEvent(event)).rejects.toThrow(/^webhook fan-out failed for 1\/2 webhooks: hook-v2$/);
    expect(record).toHaveBeenCalledExactlyOnceWith(v1, event);
    expect(queue).toHaveBeenCalledExactlyOnceWith({ deliveryId: 'delivery-v1', webhookId: 'hook-v1', generation: 1, attemptsMade: 0 }, expect.any(Date));
  });

  it.each([{ versions: [1] }, { versions: [1, 2, 2] }] as const)('enriches lazily once for targets $versions', async ({ versions }) => {
    const targets = versions.map((v, i) => target(`hook-${i}`, v));
    const record = vi.fn(async () => ({ created: true as const, deliveryId: 'delivery-1' }));
    const queue = mocks.queue;
    configureWebhookFanout({ getWebhooksForEvent: async () => targets, createDeliveryRecord: record });
    await handleWebhookFanoutEvent(event);
    expect(mocks.enrich).toHaveBeenCalledTimes(versions.some(version => version === 2) ? 1 : 0);
    versions.forEach((v, i) => {
      const expectedEvent = v === 2 ? { ...event, payload: org } : event;
      expect(record).toHaveBeenNthCalledWith(i + 1, targets[i], expectedEvent);
      expect(queue).toHaveBeenNthCalledWith(i + 1, { deliveryId: 'delivery-1', webhookId: targets[i]!.id, generation: 1, attemptsMade: 0 }, expect.any(Date));
    });
    expect(event.payload).toEqual({ alertId: 'alert-1' });
  });
  it.each(['alert.correlation_group.created', 'device.offline'] as const)('does not enrich %s', async type => {
    const queue = mocks.queue;
    configureWebhookFanout({ getWebhooksForEvent: async () => [target('hook-1', 2)], createDeliveryRecord: async () => ({ created: true, deliveryId: 'delivery-1' }) });
    const rawEvent = { ...event, type };
    await handleWebhookFanoutEvent(rawEvent);
    expect(mocks.enrich).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledWith({ deliveryId: 'delivery-1', webhookId: 'hook-1', generation: 1, attemptsMade: 0 }, expect.any(Date));
  });
  it.each([1, 2] as const)('signs the actual body for version %s and carries replay headers', async payloadVersion => {
    await deliverWebhook(job({ payloadVersion, replayOf: 'original-id' }));
    const { body, headers } = mocks.fetch.mock.calls[0]![1];
    const parsed = JSON.parse(body);
    expect(parsed.schemaVersion).toBe(payloadVersion === 2 ? 2 : undefined);
    expect(parsed.replayOf).toBe(payloadVersion === 2 ? 'original-id' : undefined);
    expect(headers['X-Breeze-Replay-Of']).toBe('original-id');
    expect(headers['X-Breeze-Signature']).toBe('sha256=' + createHmac('sha256', 'secret').update(headers['X-Breeze-Signature-Timestamp'] + '.' + body).digest('hex'));
  });
});


describe('partner payload isolation', () => {
  it.each([false, true])('keeps projections separate with partnerFirst=%s', async partnerFirst => {
    const partnerPayload = Object.freeze({ ...org, orgExternalIds: Object.freeze([{ system: 'connectwise', externalId: 'company-1' }]) });
    mocks.enrich.mockResolvedValue({ org, partner: partnerPayload });
    const orgTarget = { ...target('org-hook', 2), partnerId: null };
    const partnerTarget = { ...target('partner-hook', 2), orgId: null, partnerId: 'partner-1' };
    const targets = partnerFirst ? [partnerTarget, orgTarget] : [orgTarget, partnerTarget];
    const recorded = new Map<string, unknown>();
    configureWebhookFanout({ getWebhooksForEvent: async () => targets, createDeliveryRecord: async (hook, event) => {
      recorded.set(hook.id, event.payload);
      expect(Object.isFrozen(event.payload)).toBe(true);
      return { created: true, deliveryId: hook.id };
    } });
    await handleWebhookFanoutEvent(event);
    expect(recorded.get('partner-hook')).toEqual(partnerPayload);
    expect(recorded.get('org-hook')).not.toHaveProperty('orgExternalIds');
    expect(recorded.get('org-hook')).not.toBe(recorded.get('partner-hook'));
    expect(event.payload).toEqual({ alertId: 'alert-1' });
  });
});
