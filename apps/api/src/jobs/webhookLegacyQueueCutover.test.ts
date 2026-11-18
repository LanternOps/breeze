import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  lists: {} as Record<string, string[]>, reads: [] as Array<unknown[] | Error>,
  limit: vi.fn(), values: vi.fn(), conflict: vi.fn(), set: vi.fn(), returning: vi.fn(),
  context: vi.fn(), enqueue: vi.fn(), capture: vi.fn(),
}));
vi.mock('../services/redis', () => ({ getRedisConnection: () => ({
  rpop: async (key: string) => mocks.lists[key]?.pop() ?? null,
  llen: async (key: string) => mocks.lists[key]?.length ?? 0,
  exists: async (...keys: string[]) => keys.filter(key => (mocks.lists[key]?.length ?? 0) > 0).length,
  lmove: async (src: string, dst: string, from: string, to: string) => {
    const raw = from === 'RIGHT' ? mocks.lists[src]?.pop() : mocks.lists[src]?.shift();
    if (raw === undefined) return null;
    const dest = mocks.lists[dst] ??= [];
    if (to === 'LEFT') dest.unshift(raw); else dest.push(raw);
    return raw;
  },
  lrem: async (key: string, count: number, raw: string) => {
    const list = mocks.lists[key] ?? [];
    let removed = 0;
    for (let i = count < 0 ? list.length - 1 : 0; i >= 0 && i < list.length;) {
      if (list[i] === raw && (count === 0 || removed < Math.abs(count))) {
        list.splice(i, 1); removed += 1;
        if (count < 0) i -= 1;
      } else i += count < 0 ? -1 : 1;
    }
    return removed;
  },
}) }));
vi.mock('../services/sentry', () => ({ captureException: mocks.capture }));
vi.mock('./webhookDeliveryQueue', () => ({ enqueueWebhookAttempt: mocks.enqueue }));
vi.mock('../db', () => ({
  withSystemDbAccessContext: mocks.context,
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: mocks.limit }) }), where: () => ({ limit: mocks.limit }) }) }),
    update: () => ({ set: mocks.set }), insert: () => ({ values: mocks.values }),
  },
}));
import { webhookDeliveries } from '../db/schema';
import { drainLegacyWebhookQueues, legacyWebhookQueuesPending } from './webhookLegacyQueueCutover';
const now = new Date('2027-01-12T00:00:00Z');
const id = '11111111-1111-4111-8111-111111111111';
const webhookId = '22222222-2222-4222-8222-222222222222';
const job = { id, webhookId, attempts: 2, nextRetryAt: new Date(+now + 30_000).toISOString(), event: { id: 'evt', type: 'device.online', payload: { deviceId: 'dev' }, metadata: { timestamp: '2027-01-11T00:00:00Z' } }, webhook: { url: 'https://legacy.example', secret: 'plaintext' } };
const empty = { drained: 0, drainRowGone: 0, drainResolved: 0, dlqInserted: 0, dlqAlreadyPresent: 0, dlqWebhookGone: 0, malformed: 0, failed: 0, truncated: false };
const queued = (entry: unknown) => { mocks.lists['breeze:webhooks:delivery'] = [JSON.stringify(entry)]; };
const dead = (entry: unknown) => { mocks.lists['breeze:webhooks:dlq'] = [JSON.stringify(entry)]; };
const row = (extra: object = {}) => ({ id, webhookId, status: 'pending', attempts: 0, approvalGeneration: 4, webhookGeneration: null, errorMessage: null, ...extra });
describe('legacy webhook queue cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
    mocks.lists = {}; mocks.reads.length = 0;
    mocks.limit.mockImplementation(async () => { const next = mocks.reads.shift(); if (next instanceof Error) throw next; return next ?? []; });
    mocks.context.mockImplementation(async (fn: () => unknown) => fn());
    mocks.set.mockReturnValue({ where: () => ({ returning: mocks.returning }) });
    mocks.returning.mockResolvedValue([{ id }]);
    mocks.values.mockReturnValue({ onConflictDoNothing: mocks.conflict }); mocks.conflict.mockReturnValue({ returning: mocks.returning });
    mocks.enqueue.mockResolvedValue('job-id');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('re-drives a pending row using persisted attempts and current generation without embedded credentials', async () => {
    queued(job); mocks.reads.push([row({ attempts: 1 })]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drained: 1 });
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ deliveryId: id, webhookId, generation: 4, attemptsMade: 1 }, now);
    expect(mocks.context).toHaveBeenCalledOnce();
    expect(mocks.values).not.toHaveBeenCalled();
    expect(JSON.stringify([...mocks.enqueue.mock.calls, ...mocks.values.mock.calls, ...mocks.set.mock.calls.map(([values]) => Object.keys(values))])).not.toMatch(/url|secret|plaintext|legacy.example/);
  });
  it('converts an old failed attempt to scheduled and keeps its future due time and generation', async () => {
    queued({ ...job, generation: 2 }); mocks.reads.push([row({ status: 'failed', attempts: 2 })]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drained: 1 });
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'scheduled', nextRetryAt: new Date(job.nextRetryAt), webhookGeneration: expect.any(Object) }));
    const generation = new PgDialect().sqlToQuery(mocks.set.mock.calls[0]![0].webhookGeneration as SQL);
    expect(generation.sql).toContain('COALESCE(');
    expect(generation.params).toEqual([2]);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ deliveryId: id, webhookId, generation: 2, attemptsMade: 2 }, new Date(job.nextRetryAt));
    expect(JSON.stringify(mocks.set.mock.calls.map(([values]) => Object.keys(values)))).not.toMatch(/url|secret/);
  });
  it('clamps an old retry due time to now', async () => {
    queued({ ...job, nextRetryAt: '2027-01-01T00:00:00Z' }); mocks.reads.push([row({ status: 'failed', attempts: 2 })]);
    await drainLegacyWebhookQueues(); expect(mocks.enqueue.mock.calls[0]![1]).toEqual(now);
  });
  it.each([[], [row({ status: 'delivered' })], [row({ status: 'failed', attempts: 3 })], [row({ status: 'failed', attempts: 2, errorMessage: 'superseded_by_edit: disabled' })], [row({ status: 'failed', attempts: 0 })]].map(rows => ({ rows })))('drops missing, resolved, mismatched and superseded deliveries %j', async ({ rows }) => {
    queued(job); mocks.reads.push(rows);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, [rows.length ? 'drainResolved' : 'drainRowGone']: 1 });
    expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('drops a retry whose conversion CAS lost', async () => {
    queued(job); mocks.reads.push([row({ status: 'failed', attempts: 2 })]); mocks.returning.mockResolvedValue([]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drainResolved: 1 }); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('counts an existing DLQ delivery as ingested without writing', async () => {
    dead({ job, lastResult: {}, movedAt: now.toISOString() }); mocks.reads.push([{ id: webhookId }], [{ id }]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqAlreadyPresent: 1 }); expect(mocks.values).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('inserts an orphaned DLQ replay as failed with dedupe and no embedded credentials', async () => {
    dead({ job: { ...job, payloadVersion: 2, replayOf: 'root', createdAt: '2027-01-10T00:00:00Z' }, lastResult: { attempts: 5, responseStatus: 503, errorMessage: 'endpoint down' }, movedAt: now.toISOString() });
    mocks.reads.push([{ id: webhookId }], []);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqInserted: 1 });
    expect(mocks.values).toHaveBeenCalledExactlyOnceWith({ id, webhookId, eventType: 'device.online', eventId: 'evt', payload: { deviceId: 'dev' }, payloadVersion: 2, eventTimestamp: new Date('2027-01-11T00:00:00Z'), replayRootEventId: 'root', status: 'failed', failedAt: now, webhookGeneration: null, attempts: 5, responseStatus: 503, errorMessage: 'endpoint down', createdAt: new Date('2027-01-10T00:00:00Z') });
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
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqInserted: 1 });
    expect(mocks.values.mock.calls[0]![0].attempts).toBe(expected);
  });
  it('drops a DLQ entry whose webhook is gone', async () => {
    dead({ job }); mocks.reads.push([]); expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqWebhookGone: 1 }); expect(mocks.values).not.toHaveBeenCalled();
  });
  it('logs combined counts once, drops malformed JSON, and a second drain is a no-op', async () => {
    mocks.lists = { 'breeze:webhooks:delivery': ['{bad'], 'breeze:webhooks:dlq': ['{bad'] };
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, malformed: 2 });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('WEBHOOK_LEGACY_QUEUE_CUTOVER'));
    expect(await drainLegacyWebhookQueues()).toEqual(empty);
    expect(console.warn).toHaveBeenCalledOnce(); expect(mocks.values).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('preserves the recorded generation instead of an edited webhook or legacy job generation', async () => {
    queued({ ...job, generation: 2 }); mocks.reads.push([row({ webhookGeneration: 3 })]);
    await drainLegacyWebhookQueues();
    expect(mocks.enqueue.mock.calls[0]![0].generation).toBe(3);
    const generation = new PgDialect().sqlToQuery(mocks.set.mock.calls[0]![0].webhookGeneration as SQL);
    expect(generation.sql).toContain('COALESCE(');
    expect(generation.params).toEqual([2]);
  });
  it.each([
    { movedAt: 'invalid', createdAt: '2027-01-10T00:00:00Z', expected: new Date('2027-01-10T00:00:00Z') },
    { movedAt: 'invalid', createdAt: 'invalid', expected: now },
  ])('sets failedAt from movedAt, createdAt, then now: $createdAt', async ({ movedAt, createdAt, expected }) => {
    dead({ job: { ...job, generation: 3, createdAt }, movedAt }); mocks.reads.push([{ id: webhookId }], []);
    await drainLegacyWebhookQueues();
    expect(mocks.values.mock.calls[0]![0]).toMatchObject({ failedAt: expected, webhookGeneration: 3 });
  });
  it('keeps a failed middle entry in Redis while processing the other two', async () => {
    const jobs = [1, 2, 3].map(n => ({ ...job, id: `11111111-1111-4111-8111-11111111111${n}` }));
    mocks.lists['breeze:webhooks:delivery'] = jobs.map(entry => JSON.stringify(entry)).reverse();
    const error = new Error('database down');
    mocks.reads.push([row()], error, [row()]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drained: 2, failed: 1 });
    expect(mocks.enqueue.mock.calls.map(call => call[0].deliveryId)).toEqual([jobs[0]!.id, jobs[2]!.id]);
    expect(mocks.lists['breeze:webhooks:delivery']).toEqual([JSON.stringify(jobs[1])]);
    expect(mocks.lists['breeze:webhooks:delivery:cutover-processing']).toEqual([]);
    expect(mocks.capture).toHaveBeenCalledWith(error);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_LEGACY_QUEUE_ENTRY_FAILED'));
  });
  it('aborts after ten consecutive failures without losing any entries', async () => {
    mocks.lists['breeze:webhooks:delivery'] = Array.from({ length: 100_001 }, () => JSON.stringify(job));
    mocks.limit.mockRejectedValue(new Error('database down'));
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, failed: 10 });
    expect(mocks.lists['breeze:webhooks:delivery']).toHaveLength(100_001);
    expect(mocks.lists['breeze:webhooks:delivery:cutover-processing']).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_LEGACY_QUEUE_CUTOVER_ABORTED'));
  });
  it('recovers an entry left in the processing list and becomes a no-op on rerun', async () => {
    mocks.lists['breeze:webhooks:delivery:cutover-processing'] = [JSON.stringify(job)];
    expect(await legacyWebhookQueuesPending()).toBe(true);
    mocks.reads.push([row()]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drained: 1 });
    expect(await legacyWebhookQueuesPending()).toBe(false);
    expect(await drainLegacyWebhookQueues()).toEqual(empty);
  });
  it('counts an ON CONFLICT no-op as already present', async () => {
    dead({ job }); mocks.reads.push([{ id: webhookId }], []); mocks.returning.mockResolvedValue([]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, dlqAlreadyPresent: 1 });
  });

  it('retries a converted scheduled row after its first enqueue failed', async () => {
    queued({ ...job, generation: 2 });
    mocks.reads.push([row({ status: 'failed', attempts: 2 })]);
    mocks.enqueue.mockRejectedValueOnce(new Error('Redis enqueue failed'));
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, failed: 1 });
    expect(mocks.lists['breeze:webhooks:delivery']).toHaveLength(1);
    mocks.reads.push([row({ status: 'scheduled', attempts: 2, webhookGeneration: 2, nextRetryAt: new Date(job.nextRetryAt) })]);
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, drained: 1 });
    expect(mocks.enqueue).toHaveBeenLastCalledWith({ deliveryId: id, webhookId, generation: 2, attemptsMade: 2 }, new Date(job.nextRetryAt));
    expect(await legacyWebhookQueuesPending()).toBe(false);
  });

  it('reports truncation only after consuming the drain limit', async () => {
    mocks.lists['breeze:webhooks:delivery'] = Array.from({ length: 100_001 }, () => '{bad');
    expect(await drainLegacyWebhookQueues()).toEqual({ ...empty, malformed: 100_000, truncated: true });
    expect(mocks.lists['breeze:webhooks:delivery']).toHaveLength(1);
    expect(mocks.lists['breeze:webhooks:delivery:cutover-processing']).toEqual([]);
  });

});
