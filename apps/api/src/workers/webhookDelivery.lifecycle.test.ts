import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
const m = vi.hoisted(() => ({ fetch: vi.fn(), enqueue: vi.fn(), select: vi.fn(), attach: vi.fn(), worker: vi.fn(), close: vi.fn(), closeQueue: vi.fn(), capture: vi.fn() }));
vi.mock('bullmq', async () => ({ ...await vi.importActual('bullmq'), Worker: class { constructor(...args: unknown[]) { m.worker(...args); } on = vi.fn(); close = m.close; } }));
vi.mock('../db', () => ({ db: { select: m.select }, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({ host: 'redis' }) }));
vi.mock('../jobs/webhookDeliveryQueue', () => ({ WEBHOOK_DELIVERY_QUEUE: 'webhook-delivery', enqueueWebhookAttempt: m.enqueue, closeWebhookDeliveryQueue: m.closeQueue }));
vi.mock('../jobs/workerObservability', () => ({ attachWorkerObservability: m.attach }));
vi.mock('../services/webhookConfig', () => ({ toWebhookConfig: (row: unknown) => row }));
vi.mock('../services/urlSafety', () => ({ safeFetch: m.fetch, SsrfBlockedError: class extends Error {} }));
vi.mock('../services/sentry', () => ({ captureException: m.capture }));
const deliveryId = '11111111-1111-4111-8111-111111111111';
const webhookId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-28T12:00:00Z');
const delays = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
import * as mod from './webhookDelivery';
const claim = vi.fn();
const recordOutcome = vi.fn();
const row = { orgId: 'org-1', id: deliveryId, webhookId, eventId: 'event-1', eventType: 'device.created', payload: {}, payloadVersion: 1, webhookGeneration: 3, eventTimestamp: now, createdAt: now, replayRootEventId: null, attempts: 0 };
let webhook: Record<string, unknown>;
function job(attemptsMade = 0) { return { data: { deliveryId, webhookId, generation: 3, attemptsMade } } as Job; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  claim.mockResolvedValue({ claimed: true, delivery: row });
  recordOutcome.mockResolvedValue(true);
  m.enqueue.mockResolvedValue('job');
  webhook = { id: webhookId, orgId: 'org-1', partnerId: null, status: 'active', approvalGeneration: 3, url: 'https://hooks.example.com', events: [] };
  m.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [webhook] }) }) });
  m.fetch.mockResolvedValue(new Response('error', { status: 503 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('requires execution callbacks before processing', async () => {
  await expect(mod.processWebhookAttemptJob(job(), 'token')).rejects.toThrow(/configureWebhookDeliveryExecution/);
});

describe('webhook attempt outcomes', () => {
  beforeEach(() => mod.configureWebhookDeliveryExecution({ claim, recordOutcome, releaseClaim: vi.fn() }));
  it.each([{ status: 'disabled' }, { approvalGeneration: 4 }])('supersedes changed lifecycle %j', async change => {
    Object.assign(webhook, change);
    await mod.processWebhookAttemptJob(job(), 'token');
    expect(m.fetch).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ superseded: true, supersededReason: 'superseded', success: false, nextAttemptAt: null }));
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_SUPERSEDED'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"cause":"superseded"'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"orgId":"org-1"'));
  });
  it.each([
    { name: 'missing org', org: undefined, cause: 'org_departed', message: "superseded_by_edit: organization no longer belongs to this webhook's partner" },
    { name: 'moved org', org: { partnerId: 'other-partner', live: true }, cause: 'org_departed', message: "superseded_by_edit: organization no longer belongs to this webhook's partner" },
    ...['suspended', 'merging', 'archived', 'holding', 'quick-support', 'soft-deleted'].map(name => ({
      name, org: { partnerId: 'partner-1', live: false }, cause: 'org_inactive',
      message: 'superseded_by_edit: organization is not active for partner-wide delivery',
    })),
  ])('reports an accurate cause and event org for $name without POST or retry', async ({ org, cause, message }) => {
    Object.assign(webhook, { orgId: null, partnerId: 'partner-1' });
    m.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [webhook] }) }) });
    m.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => org ? [org] : [] }) }) });
    await mod.processWebhookAttemptJob(job(), 'token');
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      superseded: true, supersededReason: cause, nextAttemptAt: null, errorMessage: message,
    }));
    const warning = vi.mocked(console.warn).mock.calls.find(([line]) => String(line).includes('WEBHOOK_DELIVERY_SUPERSEDED'))![0];
    expect(JSON.parse(String(warning).slice(String(warning).indexOf('{')))).toMatchObject({
      cause, orgId: row.orgId, deliveryId, webhookId,
    });
  });
  it.each([1, 2, 3, 4, 5, 6])('schedules failure of attempt %i from the persisted outcome', async attempt => {
    claim.mockResolvedValue({ claimed: true, delivery: { ...row, attempts: attempt - 1 } });
    await mod.processWebhookAttemptJob(job(attempt - 1), 'token');
    const result = recordOutcome.mock.calls[0]![0];
    expect(result.attempts).toBe(attempt);
    expect(result.nextAttemptAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(delays[attempt - 1]! * .8);
    expect(result.nextAttemptAt.getTime() - now.getTime()).toBeLessThanOrEqual(delays[attempt - 1]! * 1.2);
    expect(m.enqueue).toHaveBeenCalledExactlyOnceWith({ deliveryId, webhookId, generation: 3, attemptsMade: attempt }, result.nextAttemptAt);
    expect(recordOutcome.mock.invocationCallOrder[0]).toBeLessThan(m.enqueue.mock.invocationCallOrder[0]!);
  });
  it('exhausts the seventh failure', async () => {
    claim.mockResolvedValue({ claimed: true, delivery: { ...row, attempts: 6 } });
    await mod.processWebhookAttemptJob(job(6), 'token');
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ attempts: 7, nextAttemptAt: null }));
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_RETRIES_EXHAUSTED'));
  });
  it('does not schedule successful deliveries', async () => {
    m.fetch.mockResolvedValue(new Response('ok'));
    await mod.processWebhookAttemptJob(job(), 'token');
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ success: true, nextAttemptAt: null }));
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it('does not enqueue when the outcome CAS lost', async () => {
    recordOutcome.mockResolvedValue(false);
    await mod.processWebhookAttemptJob(job(), 'token');
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it('leaves an enqueue failure for recovery without failing this job', async () => {
    m.enqueue.mockRejectedValue(new Error('redis down'));
    await expect(mod.processWebhookAttemptJob(job(), 'token')).resolves.toBeUndefined();
    expect(m.capture).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_RETRY_ENQUEUE_FAILED'));
  });
});
describe('worker lifecycle', () => {
  it('import and API-role fan-out never create or attach a worker', async () => {
    mod.configureWebhookFanout({ getWebhooksForEvent: async () => [{ id: webhookId, orgId: 'org-1', partnerId: null, approvalGeneration: 3, payloadVersion: 1 }], createDeliveryRecord: async () => ({ created: true, deliveryId }) });
    await mod.handleWebhookFanoutEvent({ id: 'event-1', type: 'device.created', orgId: 'org-1', payload: {}, metadata: { timestamp: now.toISOString() } } as never);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.worker).not.toHaveBeenCalled();
    expect(m.attach).not.toHaveBeenCalled();
  });
  it('initializes one BullMQ worker and closes it and its queue', async () => {
    await mod.initializeWebhookDelivery();
    await mod.initializeWebhookDelivery();
    expect(m.worker).toHaveBeenCalledExactlyOnceWith('webhook-delivery', expect.any(Function), { connection: { host: 'redis' }, concurrency: 10 });
    expect(m.attach).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 'webhookDeliveryWorker');
    await mod.shutdownWebhookDelivery();
    await mod.shutdownWebhookDelivery();
    expect(m.close).toHaveBeenCalledTimes(1);
    expect(m.closeQueue).toHaveBeenCalled();
  });
});
