import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #4142 W2: the relay-evict producer. The relay module itself is real; only
// its edges (Redis, the socket map, presence, the DB context, BullMQ) are
// mocked, so local-first routing, shard checks and ack parsing run for real.

const redisMock = { set: vi.fn(), get: vi.fn(), eval: vi.fn(), exists: vi.fn() };
vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
  getRedisConnection: vi.fn(() => redisMock),
  getBullMQConnection: vi.fn(() => redisMock),
}));

vi.mock('../routes/agentWs', () => ({
  isAgentConnected: vi.fn(),
  sendCommandToAgent: vi.fn(),
  disconnectAgent: vi.fn(),
}));
vi.mock('./agentPresence', () => ({
  readAgentPresence: vi.fn(),
  probeAgentPresence: vi.fn(),
  readAgentPresenceBatch: vi.fn(),
}));
vi.mock('../db', () => ({
  hasDbAccessContext: vi.fn(() => false),
}));
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(),
}));
vi.mock('../config/env', () => ({
  breezeRole: vi.fn(() => 'all'),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import {
  RELAY_EVICT_JOB_NAME,
  RELAY_EVICT_MAX_ENTRIES,
  RELAY_EVICT_QUEUED_TTL_MS,
  evictAgentSockets,
  type EvictRequest,
} from './agentCommandRelayEvict';
import {
  __resetRelayRedisFailureLogForTests,
  RELAY_DELIVERY_DEADLINE_MS,
  RELAY_TRANSPORT_DEADLINE_MS,
  shutdownAgentCommandRelayQueue,
} from './agentCommandRelay';
import { disconnectAgent } from '../routes/agentWs';
import { readAgentPresenceBatch } from './agentPresence';
import { hasDbAccessContext } from '../db';
import { createInstrumentedQueue } from './bullmqQueue';
import { breezeRole } from '../config/env';

type AddCall = [name: string, data: Record<string, any>, opts: Record<string, any>];

const queues = new Map<string, { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>();

function addCalls(): AddCall[] {
  return [...queues.values()].flatMap((q) => q.add.mock.calls as AddCall[]);
}

function lease(instanceId: string, connectionToken = `tok-${instanceId}`) {
  return { instanceId, connectionToken };
}

function leasesFor(map: Record<string, ReturnType<typeof lease> | null>) {
  vi.mocked(readAgentPresenceBatch).mockImplementation(async (ids) => {
    const out = new Map<string, ReturnType<typeof lease> | null>();
    for (const id of ids) out.set(id, map[id] ?? null);
    return out;
  });
}

const req = (agentId: string, code: EvictRequest['code'] = 4001, reason = 'Tenant suspended'): EvictRequest => ({
  agentId, code, reason,
});

describe('evictAgentSockets (#4142 W2)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetRelayRedisFailureLogForTests();
    await shutdownAgentCommandRelayQueue();
    queues.clear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(breezeRole).mockReturnValue('all');
    vi.mocked(hasDbAccessContext).mockReturnValue(false);
    vi.mocked(disconnectAgent).mockReturnValue('not-connected');
    redisMock.exists.mockResolvedValue(1);
    redisMock.get.mockResolvedValue(null);
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = { add: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined) };
      queues.set(name, q);
      return q;
    }) as never);
    leasesFor({});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('local-first: a locally connected agent is closed without touching Redis', async () => {
    vi.mocked(disconnectAgent).mockReturnValue('closed');

    const out = await evictAgentSockets([req('agent-1', 4041, 'quick support session ended')]);

    expect(out.get('agent-1')).toEqual({ status: 'closed', via: 'local' });
    expect(disconnectAgent).toHaveBeenCalledWith('agent-1', 4041, 'quick support session ended');
    expect(readAgentPresenceBatch).not.toHaveBeenCalled();
    expect(redisMock.exists).not.toHaveBeenCalled();
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
  });

  it('a local close that throws is close_failed via local, not retried through the relay', async () => {
    vi.mocked(disconnectAgent).mockReturnValue('close-failed');

    const out = await evictAgentSockets([req('agent-1')]);

    expect(out.get('agent-1')).toEqual({ status: 'close_failed', via: 'local' });
    expect(readAgentPresenceBatch).not.toHaveBeenCalled();
  });

  it('the worker role never loads the socket map and routes every entry by lease', async () => {
    vi.mocked(breezeRole).mockReturnValue('worker');
    leasesFor({ 'agent-1': lease('inst-a') });

    const out = await evictAgentSockets([req('agent-1')], { awaitAck: false });

    expect(disconnectAgent).not.toHaveBeenCalled();
    expect(out.get('agent-1')).toEqual({ status: 'queued' });
  });

  it('an agent with no lease is not_connected', async () => {
    const out = await evictAgentSockets([req('agent-1')], { awaitAck: false });
    expect(out.get('agent-1')).toEqual({ status: 'not_connected' });
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
  });

  it(`remote agents are grouped by lease instance into <= RELAY_EVICT_MAX_ENTRIES-entry jobs, deduplicated`, async () => {
    const onA = Array.from({ length: RELAY_EVICT_MAX_ENTRIES + 100 }, (_, i) => `a-${i}`);
    const onB = Array.from({ length: 401 }, (_, i) => `b-${i}`);
    const map: Record<string, ReturnType<typeof lease>> = {};
    for (const id of onA) map[id] = lease('inst-a', `tok-${id}`);
    for (const id of onB) map[id] = lease('inst-b', `tok-${id}`);
    leasesFor(map);

    const requests = [...onA, ...onB, 'a-0', 'b-7'].map((id) => req(id));
    const out = await evictAgentSockets(requests, { awaitAck: false });

    expect(out.size).toBe(onA.length + onB.length);
    expect([...out.values()].every((o) => o.status === 'queued')).toBe(true);
    // One batched presence read for the de-duplicated remote set.
    expect(readAgentPresenceBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readAgentPresenceBatch).mock.calls[0]![0]).toHaveLength(onA.length + onB.length);

    const calls = addCalls();
    expect(calls).toHaveLength(3);
    const byQueue = [...queues.entries()].map(([name, q]) => [name, q.add.mock.calls.map((c) => c[1].entries.length)]);
    expect(Object.fromEntries(byQueue)).toEqual({
      'agent-command-relay-inst-a': [RELAY_EVICT_MAX_ENTRIES, 100],
      'agent-command-relay-inst-b': [401],
    });
    for (const [name, data, opts] of calls) {
      expect(name).toBe(RELAY_EVICT_JOB_NAME);
      // No top-level agentId / commandId / sealedCommand: an old consumer that
      // reads this as a send job finds nothing to send.
      expect(data).not.toHaveProperty('agentId');
      expect(data).not.toHaveProperty('commandId');
      expect(data).not.toHaveProperty('sealedCommand');
      expect(data.awaitAck).toBe(false);
      expect(opts).toMatchObject({ attempts: 1, jobId: `relay-${data.relayId}` });
      for (const entry of data.entries) {
        expect(entry).toEqual({
          agentId: entry.agentId, connectionToken: `tok-${entry.agentId}`, code: 4001, reason: 'Tenant suspended',
        });
      }
    }
    const allEntries = calls.flatMap((c) => c[1].entries.map((e: { agentId: string }) => e.agentId));
    expect(new Set(allEntries).size).toBe(allEntries.length);
  });

  it('a queued (no-ack) eviction carries the longer queued expiry; an awaited one the delivery deadline', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    leasesFor({ 'agent-1': lease('inst-a') });
    await evictAgentSockets([req('agent-1')], { awaitAck: false });
    redisMock.get.mockResolvedValue(JSON.stringify({ kind: 'evict', outcomes: { 'agent-1': { status: 'closed', via: 'relay' } } }));
    await evictAgentSockets([req('agent-1')]);

    const [queuedJob, awaitedJob] = addCalls().map((c) => c[1]);
    expect(queuedJob!.expiresAt).toBe(1_700_000_000_000 + RELAY_EVICT_QUEUED_TTL_MS);
    expect(awaitedJob!.expiresAt).toBe(1_700_000_000_000 + RELAY_DELIVERY_DEADLINE_MS);
    expect(awaitedJob!.awaitAck).toBe(true);
  });

  it('a presence batch read failure yields unavailable (not not_connected) for remote entries and still closes local ones', async () => {
    vi.mocked(disconnectAgent).mockImplementation((agentId) => (agentId === 'local-1' ? 'closed' : 'not-connected'));
    vi.mocked(readAgentPresenceBatch).mockRejectedValue(new Error('redis down'));

    const out = await evictAgentSockets([req('local-1'), req('remote-1')]);

    expect(out.get('local-1')).toEqual({ status: 'closed', via: 'local' });
    expect(out.get('remote-1')).toEqual({ status: 'unavailable', reason: 'presence_unavailable' });
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
  });

  it('a dead shard yields unavailable, not not_connected', async () => {
    leasesFor({ 'agent-1': lease('inst-a') });
    redisMock.exists.mockResolvedValue(0);

    const out = await evictAgentSockets([req('agent-1')]);

    expect(out.get('agent-1')).toEqual({ status: 'unavailable', reason: 'shard_dead' });
    expect(addCalls()).toHaveLength(0);
  });

  it("inside a held DB context: no presence read, no enqueue, unavailable 'held_db_context'; local closes still run", async () => {
    vi.mocked(hasDbAccessContext).mockReturnValue(true);
    vi.mocked(disconnectAgent).mockImplementation((agentId) => (agentId === 'local-1' ? 'closed' : 'not-connected'));
    leasesFor({ 'remote-1': lease('inst-a') });

    const out = await evictAgentSockets([req('local-1'), req('remote-1')]);

    expect(out.get('local-1')).toEqual({ status: 'closed', via: 'local' });
    expect(out.get('remote-1')).toEqual({ status: 'unavailable', reason: 'held_db_context' });
    expect(readAgentPresenceBatch).not.toHaveBeenCalled();
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
  });

  it('awaits the evict ack and maps each entry; a missing or unreadable entry is indeterminate', async () => {
    leasesFor({ a1: lease('inst-a'), a2: lease('inst-a'), a3: lease('inst-a'), a4: lease('inst-a') });
    redisMock.get.mockResolvedValue(JSON.stringify({
      kind: 'evict',
      outcomes: {
        a1: { status: 'closed', via: 'relay' },
        a2: { status: 'owner_mismatch' },
        a4: { status: 'closed', via: 'teleport' },
      },
    }));

    const out = await evictAgentSockets([req('a1'), req('a2'), req('a3'), req('a4')]);

    expect(out.get('a1')).toEqual({ status: 'closed', via: 'relay' });
    expect(out.get('a2')).toEqual({ status: 'owner_mismatch' });
    expect(out.get('a3')).toEqual({ status: 'indeterminate' });
    expect(out.get('a4')).toEqual({ status: 'indeterminate' });
  });

  it('an old-consumer scalar ack ({status:"offline"}) maps every entry to indeterminate', async () => {
    leasesFor({ a1: lease('inst-old'), a2: lease('inst-old') });
    redisMock.get.mockResolvedValue(JSON.stringify({ status: 'offline' }));

    const out = await evictAgentSockets([req('a1'), req('a2')]);

    expect(out.get('a1')).toEqual({ status: 'indeterminate' });
    expect(out.get('a2')).toEqual({ status: 'indeterminate' });
  });

  it('no ack within the transport deadline is indeterminate', async () => {
    vi.useFakeTimers();
    leasesFor({ a1: lease('inst-a') });

    const pending = evictAgentSockets([req('a1')]);
    await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS + 200);

    await expect(pending).resolves.toEqual(new Map([['a1', { status: 'indeterminate' }]]));
  });

  it('an enqueue that rejects after being issued is indeterminate', async () => {
    leasesFor({ a1: lease('inst-a') });
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = { add: vi.fn().mockRejectedValue(new Error('connection reset')), close: vi.fn().mockResolvedValue(undefined) };
      queues.set(name, q);
      return q;
    }) as never);

    const out = await evictAgentSockets([req('a1')], { awaitAck: false });

    expect(out.get('a1')).toEqual({ status: 'indeterminate' });
  });

  it('an enqueue that never settles is indeterminate within RELAY_TRANSPORT_DEADLINE_MS', async () => {
    vi.useFakeTimers();
    leasesFor({ a1: lease('inst-a') });
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = { add: vi.fn(() => new Promise(() => {})), close: vi.fn().mockResolvedValue(undefined) };
      queues.set(name, q);
      return q;
    }) as never);

    const pending = evictAgentSockets([req('a1')], { awaitAck: false });
    await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS + 1);

    await expect(pending).resolves.toEqual(new Map([['a1', { status: 'indeterminate' }]]));
  });

  it('a synchronous enqueue throw sent nothing: unavailable, not indeterminate', async () => {
    leasesFor({ a1: lease('inst-a') });
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = { add: vi.fn(() => { throw new Error('queue closed'); }), close: vi.fn().mockResolvedValue(undefined) };
      queues.set(name, q);
      return q;
    }) as never);

    const out = await evictAgentSockets([req('a1')], { awaitAck: false });

    expect(out.get('a1')).toEqual({ status: 'unavailable', reason: 'enqueue_failed' });
  });

  it('rejects a disallowed close code or an over-long reason per entry, sending nothing for it', async () => {
    vi.mocked(disconnectAgent).mockReturnValue('closed');

    const out = await evictAgentSockets([
      { agentId: 'bad-code', code: 1000 as never, reason: 'x' },
      req('long-reason', 4001, 'r'.repeat(121)),
      req('ok'),
    ]);

    expect(out.get('bad-code')).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(out.get('long-reason')).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(out.get('ok')).toEqual({ status: 'closed', via: 'local' });
    expect(disconnectAgent).toHaveBeenCalledTimes(1);
  });

  it('never rejects: an unexpected throw answers every unanswered entry unavailable', async () => {
    vi.mocked(disconnectAgent).mockImplementation(() => { throw new Error('boom'); });

    const out = await evictAgentSockets([req('a1'), req('a2')]);

    expect(out.get('a1')).toEqual({ status: 'unavailable', reason: 'unexpected_error' });
    expect(out.get('a2')).toEqual({ status: 'unavailable', reason: 'unexpected_error' });
  });

  it('answers an empty map for no requests', async () => {
    await expect(evictAgentSockets([])).resolves.toEqual(new Map());
    expect(disconnectAgent).not.toHaveBeenCalled();
  });
});

describe('evictAgentSockets across instances, awaited (#4142 W2)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  /** relayId -> the job data the producer enqueued under it. */
  const jobsByRelay = new Map<string, { targetInstanceId: string; entries: Array<{ agentId: string }> }>();

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetRelayRedisFailureLogForTests();
    await shutdownAgentCommandRelayQueue();
    queues.clear();
    jobsByRelay.clear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(breezeRole).mockReturnValue('all');
    vi.mocked(hasDbAccessContext).mockReturnValue(false);
    vi.mocked(disconnectAgent).mockReturnValue('not-connected');
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = {
        add: vi.fn(async (_name: string, data: { relayId: string; targetInstanceId: string; entries: Array<{ agentId: string }> }) => {
          jobsByRelay.set(data.relayId, data);
          return {};
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      queues.set(name, q);
      return q;
    }) as never);
  });

  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  /** Each instance's consumer answers its own jobs; `null` = it never answers. */
  function consumers(answer: Record<string, ((agentIds: string[]) => unknown) | null>) {
    redisMock.get.mockImplementation(async (key: string) => {
      const job = jobsByRelay.get(key.replace('agent-relay-ack:', ''));
      if (!job) return null;
      const reply = answer[job.targetInstanceId];
      return reply ? JSON.stringify(reply(job.entries.map((e) => e.agentId))) : null;
    });
  }
  const evictAck = (status: Record<string, unknown>) => (ids: string[]) =>
    ({ kind: 'evict', outcomes: Object.fromEntries(ids.map((id) => [id, status])) });

  it('keeps every instance\'s outcome its own: closed, dead shard, no answer and no lease in one call', async () => {
    vi.useFakeTimers();
    leasesFor({ a1: lease('inst-a'), b1: lease('inst-b'), c1: lease('inst-c') });
    redisMock.exists.mockImplementation(async (key: string) => (key === 'agent-relay-shard:inst-b' ? 0 : 1));
    consumers({ 'inst-a': evictAck({ status: 'closed', via: 'relay' }), 'inst-c': null });

    const pending = evictAgentSockets([req('a1'), req('b1'), req('c1'), req('gone')]);
    await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS + 200);
    const out = await pending;

    expect(Object.fromEntries(out)).toEqual({
      a1: { status: 'closed', via: 'relay' },
      b1: { status: 'unavailable', reason: 'shard_dead' },
      c1: { status: 'indeterminate' },
      gone: { status: 'not_connected' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('eviction ack did not arrive within the transport deadline'),
      'instance inst-c, 1 agent(s)',
    );
  });

  it('over RELAY_EVICT_MAX_ENTRIES on one instance: each job maps from its own ack, and a silent job is only its own entries', async () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: RELAY_EVICT_MAX_ENTRIES + 100 }, (_, i) => `a-${i}`);
    leasesFor(Object.fromEntries(ids.map((id) => [id, lease('inst-a')])));
    redisMock.exists.mockResolvedValue(1);
    // The consumer answers the full job and never the 100-entry tail job.
    redisMock.get.mockImplementation(async (key: string) => {
      const job = jobsByRelay.get(key.replace('agent-relay-ack:', ''));
      if (!job || job.entries.length !== RELAY_EVICT_MAX_ENTRIES) return null;
      return JSON.stringify(evictAck({ status: 'closed', via: 'relay' })(job.entries.map((e) => e.agentId)));
    });

    const pending = evictAgentSockets(ids.map((id) => req(id)));
    await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS + 200);
    const out = await pending;

    expect(jobsByRelay.size).toBe(2);
    const statuses = [...out.values()].map((o) => o.status);
    expect(statuses.filter((s) => s === 'closed')).toHaveLength(RELAY_EVICT_MAX_ENTRIES);
    expect(statuses.filter((s) => s === 'indeterminate')).toHaveLength(100);
  });

  it('logs an ack that is not an evict ack (a consumer from before relay-evict)', async () => {
    leasesFor({ a1: lease('inst-old') });
    redisMock.exists.mockResolvedValue(1);
    consumers({ 'inst-old': () => ({ status: 'offline' }) });

    const out = await evictAgentSockets([req('a1')]);

    expect(out.get('a1')).toEqual({ status: 'indeterminate' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('eviction ack is not an evict ack'),
      'instance inst-old, 1 agent(s)',
    );
  });
});
