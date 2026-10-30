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
const row = { orgId: 'org-1', id: deliveryId, webhookId, eventId: 'event-1', eventType: 'alert.triggered', payload: { hello: true }, payloadVersion: 1 as const, webhookGeneration: 3, eventTimestamp: now, createdAt: now, replayRootEventId: 'root-event', attempts: 0 };
const claim = vi.fn();
const recordOutcome = vi.fn();
const releaseClaim = vi.fn();
const sleep = vi.fn(async () => {});
function job(attemptsMade = 0) { return { data: { deliveryId, webhookId, generation: 3, attemptsMade }, moveToDelayed: vi.fn() } as unknown as Job; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  claim.mockResolvedValue({ claimed: true, delivery: row });
  recordOutcome.mockReset().mockResolvedValue(true);
  releaseClaim.mockResolvedValue(true);
  configureWebhookDeliveryExecution({ claim, recordOutcome, releaseClaim, sleep });
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
  it('uses the recorded generation even when the job and current webhook are newer', async () => {
    m.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: webhookId, status: 'active', approvalGeneration: 4 }] }) }) });
    const queued = job(); queued.data.generation = 4;
    await processWebhookAttemptJob(queued, 'token');
    expect(m.fetch).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ superseded: true, nextAttemptAt: null }));
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it('uses the job generation only for a legacy NULL row generation', async () => {
    claim.mockResolvedValue({ claimed: true, delivery: { ...row, webhookGeneration: null } });
    await processWebhookAttemptJob(job(), 'token');
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });
  it('retains the row generation on the next wake-up despite newer job data', async () => {
    m.fetch.mockResolvedValue(new Response('down', { status: 503 }));
    const queued = job(); queued.data.generation = 4;
    await processWebhookAttemptJob(queued, 'token');
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ generation: 3 }), expect.any(Date));
  });
  it.each([false, true])('releases a pre-send error and preserves it (release throws %s)', async releaseThrows => {
    const original = new Error('config SELECT failed');
    m.select.mockImplementation(() => { throw original; });
    if (releaseThrows) releaseClaim.mockRejectedValue(new Error('release failed'));
    await expect(processWebhookAttemptJob(job(), 'token')).rejects.toBe(original);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledExactlyOnceWith({ deliveryId, attemptsMade: 0 });
    expect(m.capture).toHaveBeenCalledWith(original);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_PRE_SEND_FAILED'));
    if (releaseThrows) expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_CLAIM_RELEASE_FAILED'));
  });
  it('retries a known outcome locally and enqueues after the successful write', async () => {
    m.fetch.mockResolvedValue(new Response('down', { status: 503 }));
    recordOutcome.mockRejectedValueOnce(new Error('temporary write failure')).mockResolvedValueOnce(true);
    await processWebhookAttemptJob(job(), 'token');
    expect(recordOutcome).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ generation: 3, attemptsMade: 1 }), expect.any(Date));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_OUTCOME_UNRECORDED'));
  });
  it('does not enqueue a late failure whose outcome CAS missed', async () => {
    m.fetch.mockResolvedValue(new Response('down', { status: 503 }));
    recordOutcome.mockResolvedValue(false);
    await processWebhookAttemptJob(job(), 'token');
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it.each([true, false])('reports and rethrows an unrecorded POST (success %s)', async success => {
    m.fetch.mockResolvedValue(new Response('body', { status: success ? 200 : 503 }));
    recordOutcome.mockRejectedValue(new Error('db write failed'));
    await expect(processWebhookAttemptJob(job(), 'token')).rejects.toThrow('db write failed');
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [1000]]);
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.capture).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_OUTCOME_UNRECORDED'));
  });
});


it.each([null, 'event-org'])('uses the claimed delivery org %s in the partner envelope', async orgId => {
  const webhook = { id: webhookId, orgId: null, partnerId: 'partner-1', status: 'active', approvalGeneration: 3, url: 'https://hooks.example.com', events: [] };
  claim.mockResolvedValue({ claimed: true, delivery: { ...row, orgId } });
  m.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [webhook] }) }) });
  if (orgId) m.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner-1', live: true }] }) }) });
  await processWebhookAttemptJob(job(), 'token');
  expect(JSON.parse(m.fetch.mock.calls[0]![1].body).orgId).toBe(orgId);
  expect(m.select).toHaveBeenCalledTimes(orgId ? 2 : 1);
});
