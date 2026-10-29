import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
const m = vi.hoisted(() => ({ fetch: vi.fn(), enqueue: vi.fn(), select: vi.fn(), capture: vi.fn() }));
vi.mock('../db', () => ({ db: { select: m.select }, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../jobs/webhookDeliveryQueue', () => ({ WEBHOOK_DELIVERY_QUEUE: 'webhook-delivery', enqueueWebhookAttempt: m.enqueue, closeWebhookDeliveryQueue: vi.fn() }));
vi.mock('../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/webhookConfig', () => ({ toWebhookConfig: (row: unknown) => row }));
vi.mock('../services/urlSafety', () => ({ safeFetch: m.fetch, SsrfBlockedError: class extends Error {} }));
vi.mock('../services/sentry', () => ({ captureException: m.capture }));
import { configureWebhookDeliveryExecution, processWebhookAttemptJob } from './webhookDelivery';
const deliveryId = '11111111-1111-4111-8111-111111111111';
const webhookId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-28T12:00:00Z');
const row = { id: deliveryId, webhookId, eventId: 'event-1', eventType: 'alert.triggered', payload: { hello: true }, payloadVersion: 1 as const, eventTimestamp: now, createdAt: now, replayRootEventId: 'root-event', attempts: 0 };
const claim = vi.fn();
const recordOutcome = vi.fn();
function job(attemptsMade = 0) { return { data: { deliveryId, webhookId, generation: 3, attemptsMade }, moveToDelayed: vi.fn() } as unknown as Job; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  claim.mockResolvedValue({ claimed: true, delivery: row });
  recordOutcome.mockResolvedValue(true);
  configureWebhookDeliveryExecution({ claim, recordOutcome });
  m.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: webhookId, orgId: 'org-1', status: 'active', approvalGeneration: 3, payloadVersion: 2, url: 'https://hooks.example.com', events: [] }] }) }) });
  m.fetch.mockResolvedValue(new Response('ok'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('durable webhook execution claims', () => {
  it.each([0, 3])('claims every attempt (%i)', async attemptsMade => {
    claim.mockResolvedValue({ claimed: true, delivery: { ...row, attempts: attemptsMade } });
    await processWebhookAttemptJob(job(attemptsMade), 'token');
    expect(claim).toHaveBeenCalledExactlyOnceWith({ deliveryId, attemptsMade });
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed ids-only data before claiming', async () => {
    await expect(processWebhookAttemptJob({ data: { deliveryId } } as Job, 'token')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(claim).not.toHaveBeenCalled();
  });
  it('drops erased delivery rows without writes or wake-ups', async () => {
    claim.mockResolvedValue({ claimed: false, observedStatus: null, observedAttempts: null, dueInMs: null });
    await processWebhookAttemptJob(job(), 'token');
    expect(m.fetch).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_ROW_GONE'));
  });
  it.each([['retrying', 0, 'already-claimed'], ['delivered', 1, 'already-resolved'], ['failed', 7, 'already-resolved'], ['pending', 2, 'stale-attempt'], ['scheduled', 2, 'stale-attempt']])('drops %s with the correct cause', async (observedStatus, observedAttempts, cause) => {
    claim.mockResolvedValue({ claimed: false, observedStatus, observedAttempts, dueInMs: null });
    await processWebhookAttemptJob(job(), 'token');
    expect(m.fetch).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`"cause":"${cause}"`));
  });
  it.each([[90_000, 90_000], [0, 1000], [null, 1000]])('preserves the job on an early wake (%s ms)', async (dueInMs, delay) => {
    claim.mockResolvedValue({ claimed: false, observedStatus: 'scheduled', observedAttempts: 0, dueInMs });
    const queued = job();
    await expect(processWebhookAttemptJob(queued, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(queued.moveToDelayed).toHaveBeenCalledExactlyOnceWith(now.getTime() + delay!, 'token');
    expect(m.fetch).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_EARLY_WAKE'));
  });
  it('fails an early wake without a lock token so BullMQ can retry', async () => {
    claim.mockResolvedValue({ claimed: false, observedStatus: 'scheduled', observedAttempts: 0, dueInMs: 10 });
    const queued = job();
    await expect(processWebhookAttemptJob(queued)).rejects.toThrow(/token/i);
    expect(queued.moveToDelayed).not.toHaveBeenCalled();
  });
  it('uses the delivery-pinned v1 body and replay root even after the webhook moves to v2', async () => {
    await processWebhookAttemptJob(job(), 'token');
    const request = m.fetch.mock.calls[0]![1];
    expect(JSON.parse(request.body)).not.toHaveProperty('schemaVersion');
    expect(request.headers['X-Breeze-Replay-Of']).toBe('root-event');
    expect(JSON.parse(request.body).timestamp).toBe(now.toISOString());
  });
  it('falls back to createdAt for a pre-versioning delivery timestamp', async () => {
    claim.mockResolvedValue({ claimed: true, delivery: { ...row, eventTimestamp: null } });
    await processWebhookAttemptJob(job(), 'token');
    expect(JSON.parse(m.fetch.mock.calls[0]![1].body).timestamp).toBe(now.toISOString());
  });
  it.each([true, false])('reports and rethrows an unrecorded POST (success %s)', async success => {
    m.fetch.mockResolvedValue(new Response('body', { status: success ? 200 : 503 }));
    recordOutcome.mockRejectedValue(new Error('db write failed'));
    await expect(processWebhookAttemptJob(job(), 'token')).rejects.toThrow('db write failed');
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.capture).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_OUTCOME_UNRECORDED'));
  });
});
