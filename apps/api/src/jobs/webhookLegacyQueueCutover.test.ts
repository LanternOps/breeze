import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  lists: {} as Record<string, string[]>, reads: [] as unknown[][],
  limit: vi.fn(), values: vi.fn(), conflict: vi.fn(), set: vi.fn(), returning: vi.fn(),
  context: vi.fn(), enqueue: vi.fn(),
}));
vi.mock('../services/redis', () => ({ getRedisConnection: () => ({ rpop: async (key: string) => mocks.lists[key]?.shift() ?? null }) }));
vi.mock('./webhookDeliveryQueue', () => ({ enqueueWebhookAttempt: mocks.enqueue }));
vi.mock('../db', () => ({
  withSystemDbAccessContext: mocks.context,
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: mocks.limit }) }), where: () => ({ limit: mocks.limit }) }) }),
    update: () => ({ set: mocks.set }), insert: () => ({ values: mocks.values }),
  },
}));
import { webhookDeliveries } from '../db/schema';
import { drainLegacyWebhookQueues } from './webhookLegacyQueueCutover';
const now = new Date('2027-01-12T00:00:00Z');
const id = '11111111-1111-4111-8111-111111111111';
const webhookId = '22222222-2222-4222-8222-222222222222';
const job = { id, webhookId, attempts: 2, nextRetryAt: new Date(+now + 30_000).toISOString(), event: { id: 'evt', type: 'device.online', payload: { deviceId: 'dev' }, metadata: { timestamp: '2027-01-11T00:00:00Z' } }, webhook: { url: 'https://legacy.example', secret: 'plaintext' } };
const empty = { drained: 0, drainDropped: 0, dlqIngested: 0, dlqDropped: 0 };
const queued = (entry: unknown) => { mocks.lists['breeze:webhooks:delivery'] = [JSON.stringify(entry)]; };
const dead = (entry: unknown) => { mocks.lists['breeze:webhooks:dlq'] = [JSON.stringify(entry)]; };
const row = (extra: object = {}) => ({ id, webhookId, status: 'pending', attempts: 0, approvalGeneration: 4, errorMessage: null, ...extra });
describe('legacy webhook queue cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
    mocks.lists = {}; mocks.reads.length = 0;
    mocks.limit.mockImplementation(async () => mocks.reads.shift() ?? []);
    mocks.context.mockImplementation(async (fn: () => unknown) => fn());
    mocks.set.mockReturnValue({ where: () => ({ returning: mocks.returning }) });
    mocks.returning.mockResolvedValue([{ id }]);
    mocks.values.mockReturnValue({ onConflictDoNothing: mocks.conflict }); mocks.conflict.mockResolvedValue([]);
    mocks.enqueue.mockResolvedValue('job-id');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('re-drives a pending row using persisted attempts and current generation without embedded credentials', async () => {
    queued(job); mocks.reads.push([row({ attempts: 1 })]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drained: 1 });
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ deliveryId: id, webhookId, generation: 4, attemptsMade: 1 }, now);
    expect(mocks.context).toHaveBeenCalledOnce();
    expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.values).not.toHaveBeenCalled();
    expect(JSON.stringify([...mocks.enqueue.mock.calls, ...mocks.set.mock.calls, ...mocks.values.mock.calls])).not.toMatch(/url|secret|plaintext|legacy.example/);
  });
  it('converts an old failed attempt to scheduled and keeps its future due time and generation', async () => {
    queued({ ...job, generation: 2 }); mocks.reads.push([row({ status: 'failed', attempts: 2 })]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drained: 1 });
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ status: 'scheduled', nextRetryAt: new Date(job.nextRetryAt) });
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ deliveryId: id, webhookId, generation: 2, attemptsMade: 2 }, new Date(job.nextRetryAt));
    expect(JSON.stringify(mocks.set.mock.calls)).not.toMatch(/url|secret/);
  });
  it('clamps an old retry due time to now', async () => {
    queued({ ...job, nextRetryAt: '2027-01-01T00:00:00Z' }); mocks.reads.push([row({ status: 'failed', attempts: 2 })]);
    await drainLegacyWebhookQueues(); expect(mocks.enqueue.mock.calls[0]![1]).toEqual(now);
  });
  it.each([[], [row({ status: 'delivered' })], [row({ status: 'failed', attempts: 3 })], [row({ status: 'failed', attempts: 2, errorMessage: 'superseded_by_edit: disabled' })], [row({ status: 'failed', attempts: 0 })]].map(rows => ({ rows })))('drops missing, resolved, mismatched and superseded deliveries %j', async ({ rows }) => {
    queued(job); mocks.reads.push(rows);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drainDropped: 1 });
    expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('drops a retry whose conversion CAS lost', async () => {
    queued(job); mocks.reads.push([row({ status: 'failed', attempts: 2 })]); mocks.returning.mockResolvedValue([]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drainDropped: 1 }); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('counts an existing DLQ delivery as ingested without writing', async () => {
    dead({ job, lastResult: {}, movedAt: now.toISOString() }); mocks.reads.push([{ id: webhookId }], [{ id }]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqIngested: 1 }); expect(mocks.values).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('inserts an orphaned DLQ replay as failed with dedupe and no embedded credentials', async () => {
    dead({ job: { ...job, payloadVersion: 2, replayOf: 'root', createdAt: '2027-01-10T00:00:00Z' }, lastResult: { attempts: 5, responseStatus: 503, errorMessage: 'endpoint down' }, movedAt: now.toISOString() });
    mocks.reads.push([{ id: webhookId }], []);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqIngested: 1 });
    expect(mocks.values).toHaveBeenCalledExactlyOnceWith({ id, webhookId, eventType: 'device.online', eventId: 'evt', payload: { deviceId: 'dev' }, payloadVersion: 2, eventTimestamp: new Date('2027-01-11T00:00:00Z'), replayRootEventId: 'root', status: 'failed', attempts: 5, responseStatus: 503, errorMessage: 'endpoint down', createdAt: new Date('2027-01-10T00:00:00Z') });
    expect(mocks.conflict).toHaveBeenCalledWith({ target: [webhookDeliveries.webhookId, webhookDeliveries.eventId] });
    expect(JSON.stringify(mocks.values.mock.calls)).not.toMatch(/url|secret/);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('uses DLQ fallbacks for absent timestamps and outcome fields', async () => {
    dead({ job: { ...job, event: { ...job.event, metadata: { timestamp: 'invalid' } } }, movedAt: '2027-01-11T00:00:00Z' }); mocks.reads.push([{ id: webhookId }], []);
    await drainLegacyWebhookQueues(); expect(mocks.values.mock.calls[0]![0]).toMatchObject({ payloadVersion: 1, eventTimestamp: null, replayRootEventId: null, attempts: 3, responseStatus: null, errorMessage: 'Moved to the retired Redis dead-letter queue', createdAt: new Date('2027-01-11T00:00:00Z') });
  });
  it.each([{ attempts: null, expected: 3 }, { attempts: 0, expected: 1 }])('normalizes DLQ attempts $attempts', async ({ attempts, expected }) => {
    dead({ job, lastResult: { attempts } }); mocks.reads.push([{ id: webhookId }], []);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqIngested: 1 });
    expect(mocks.values.mock.calls[0]![0].attempts).toBe(expected);
  });
  it('drops a DLQ entry whose webhook is gone', async () => {
    dead({ job }); mocks.reads.push([]); expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqDropped: 1 }); expect(mocks.values).not.toHaveBeenCalled();
  });
  it('logs combined counts once, drops malformed JSON, and a second drain is a no-op', async () => {
    mocks.lists = { 'breeze:webhooks:delivery': ['{bad'], 'breeze:webhooks:dlq': ['{bad'] };
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drainDropped: 1, dlqDropped: 1 });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('WEBHOOK_LEGACY_QUEUE_CUTOVER'));
    expect(await drainLegacyWebhookQueues()).toEqual(empty);
    expect(console.warn).toHaveBeenCalledOnce(); expect(mocks.values).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
