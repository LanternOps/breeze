import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4134 — per-instance relay shards: the owner key that refuses a second
// consumer on one shard, the drain that empties a shard, and the sweep that
// removes shards whose instance is gone. Redis is a hand-rolled fake here; the
// Lua scripts and real BullMQ obliteration are proven against real Redis in
// __tests__/integration/agentCommandRelayShards.integration.test.ts.

const redisMock = {
  set: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
  exists: vi.fn(),
  scan: vi.fn(),
};
let redisAvailable = true;
vi.mock('./redis', () => ({
  getRedis: vi.fn(() => (redisAvailable ? redisMock : null)),
  getRedisConnection: vi.fn(() => redisMock),
  getBullMQConnection: vi.fn(() => redisMock),
}));
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(),
}));
vi.mock('./agentPresence', () => ({
  readAgentPresence: vi.fn(),
}));
vi.mock('../config/env', () => ({
  breezeRole: vi.fn(() => 'api'),
}));
vi.mock('../routes/agentWs', () => ({
  isAgentConnected: vi.fn(),
  sendCommandToAgent: vi.fn(),
}));

import { createInstrumentedQueue } from './bullmqQueue';
import {
  acquireRelayShard,
  drainRelayQueue,
  isRelayShardLive,
  listRelayQueueNames,
  RELAY_SHARD_OWNER_TTL_MS,
  refreshRelayShard,
  relayShardOwnerKey,
  releaseRelayShard,
  sweepDeadRelayShards,
} from './agentCommandRelayShard';

type FakeQueue = {
  getJobs: ReturnType<typeof vi.fn>;
  obliterate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeQueue(jobs: unknown[] = []): FakeQueue {
  return {
    getJobs: vi.fn().mockResolvedValue(jobs),
    obliterate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisAvailable = true;
  redisMock.set.mockResolvedValue('OK');
  redisMock.exists.mockResolvedValue(0);
});

describe('shard owner key (the second-consumer guard)', () => {
  it('acquire takes the key only when absent, with the owner TTL', async () => {
    redisMock.set.mockResolvedValueOnce('OK');
    await expect(acquireRelayShard('inst-1', 'tok-1')).resolves.toBe('acquired');
    expect(redisMock.set).toHaveBeenCalledWith(
      relayShardOwnerKey('inst-1'), 'tok-1', 'PX', RELAY_SHARD_OWNER_TTL_MS, 'NX',
    );
    expect(relayShardOwnerKey('inst-1')).toBe('agent-relay-shard:inst-1');
  });

  it('acquire reports held when another consumer already owns the shard', async () => {
    redisMock.set.mockResolvedValueOnce(null);
    await expect(acquireRelayShard('inst-1', 'tok-2')).resolves.toBe('held');
  });

  it('acquire reports unavailable (never held) when Redis errors or is absent', async () => {
    redisMock.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(acquireRelayShard('inst-1', 'tok-1')).resolves.toBe('unavailable');
    redisAvailable = false;
    await expect(acquireRelayShard('inst-1', 'tok-1')).resolves.toBe('unavailable');
  });

  it('refresh maps the fenced script: 1 refreshed, 2 reacquired after a lapse, 0 lost to another token', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    await expect(refreshRelayShard('inst-1', 'tok-1')).resolves.toBe('refreshed');
    await expect(refreshRelayShard('inst-1', 'tok-1')).resolves.toBe('reacquired');
    await expect(refreshRelayShard('inst-1', 'tok-1')).resolves.toBe('lost');
    const [, numKeys, key, token, ttl] = redisMock.eval.mock.calls[0]!;
    expect([numKeys, key, token, ttl]).toEqual([1, 'agent-relay-shard:inst-1', 'tok-1', String(RELAY_SHARD_OWNER_TTL_MS)]);
  });

  it('refresh on a Redis error is unavailable, not lost (a blip must not stop the consumer)', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('timeout'));
    await expect(refreshRelayShard('inst-1', 'tok-1')).resolves.toBe('unavailable');
  });

  it('release deletes only a key that still holds this token', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(releaseRelayShard('inst-1', 'tok-1')).resolves.toBe(true);
    await expect(releaseRelayShard('inst-1', 'tok-1')).resolves.toBe(false);
    expect(redisMock.eval.mock.calls[0]?.slice(1)).toEqual([1, 'agent-relay-shard:inst-1', 'tok-1']);
  });

  it('liveness: the key exists → live; a read error counts as live so a sweep never reaps on doubt', async () => {
    redisMock.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('down'));
    await expect(isRelayShardLive('inst-1')).resolves.toBe(true);
    await expect(isRelayShardLive('inst-1')).resolves.toBe(false);
    await expect(isRelayShardLive('inst-1')).resolves.toBe(true);
  });
});

describe('drainRelayQueue', () => {
  it('acks every never-started job owner_mismatch, then obliterates the queue and closes the handle', async () => {
    const queue = fakeQueue([
      { data: { relayId: 'r-1' } },
      { data: { relayId: 'r-2' } },
      { data: {} },
      undefined,
    ]);
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);

    await expect(drainRelayQueue('agent-command-relay-inst-1')).resolves.toBe(2);

    // A handle that never rewrites the queue's meta hash.
    expect(createInstrumentedQueue).toHaveBeenCalledWith('agent-command-relay-inst-1', { skipMetasUpdate: true });
    // Active jobs are NOT read: one may be mid-send, and owner_mismatch would be a lie.
    expect(queue.getJobs.mock.calls[0]?.[0]).toEqual(['waiting', 'prioritized', 'paused', 'delayed']);
    expect(queue.getJobs.mock.calls[0]?.[0]).not.toContain('active');
    const ack = JSON.stringify({ status: 'owner_mismatch' });
    expect(redisMock.set).toHaveBeenCalledWith('agent-relay-ack:r-1', ack, 'PX', 30_000);
    expect(redisMock.set).toHaveBeenCalledWith('agent-relay-ack:r-2', ack, 'PX', 30_000);
    expect(redisMock.set).toHaveBeenCalledTimes(2);
    expect(queue.obliterate).toHaveBeenCalledWith({ force: true });
    expect(queue.obliterate.mock.invocationCallOrder[0])
      .toBeGreaterThan(redisMock.set.mock.invocationCallOrder[1]!);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it('a failed ack write does not stop the queue being removed', async () => {
    const queue = fakeQueue([{ data: { relayId: 'r-1' } }]);
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);
    redisMock.set.mockRejectedValueOnce(new Error('OOM'));

    await expect(drainRelayQueue('agent-command-relay-inst-1')).resolves.toBe(0);
    expect(queue.obliterate).toHaveBeenCalledTimes(1);
  });

  it('an obliterate failure propagates, and the handle is still closed', async () => {
    const queue = fakeQueue();
    queue.obliterate.mockRejectedValueOnce(new Error('busy'));
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);

    await expect(drainRelayQueue('agent-command-relay-inst-1')).rejects.toThrow('busy');
    expect(queue.close).toHaveBeenCalledTimes(1);
  });
});

describe('listRelayQueueNames', () => {
  it('follows the SCAN cursor and dedupes, matching only relay queue meta keys', async () => {
    redisMock.scan
      .mockResolvedValueOnce(['17', ['bull:agent-command-relay-a:meta', 'bull:agent-command-relay:meta']])
      .mockResolvedValueOnce(['0', ['bull:agent-command-relay-a:meta', 'bull:agent-command-relay-b:meta']]);

    await expect(listRelayQueueNames()).resolves.toEqual([
      'agent-command-relay-a', 'agent-command-relay', 'agent-command-relay-b',
    ]);
    expect(redisMock.scan.mock.calls[0]).toEqual(['0', 'MATCH', 'bull:agent-command-relay*:meta', 'COUNT', 500]);
    expect(redisMock.scan.mock.calls[1]?.[0]).toBe('17');
  });
});

describe('sweepDeadRelayShards', () => {
  const META = [
    'bull:agent-command-relay-self:meta',
    'bull:agent-command-relay-live:meta',
    'bull:agent-command-relay-dead:meta',
    'bull:agent-command-relay:meta',
  ];

  beforeEach(() => {
    redisMock.scan.mockResolvedValue(['0', META]);
    redisMock.exists.mockImplementation(async (key: string) => (key === 'agent-relay-shard:live' ? 1 : 0));
    vi.mocked(createInstrumentedQueue).mockImplementation((() => fakeQueue()) as never);
  });

  it('first sight only marks ownerless shards (and the legacy queue) as suspects; it removes nothing', async () => {
    const result = await sweepDeadRelayShards('self', new Set());

    expect(result.reaped).toEqual([]);
    expect([...result.suspects].sort()).toEqual(['agent-command-relay', 'agent-command-relay-dead']);
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
    // Never asks whether its own shard is live.
    expect(redisMock.exists).not.toHaveBeenCalledWith('agent-relay-shard:self');
  });

  it('a shard still ownerless on the next sweep is drained and removed; live and own shards never are', async () => {
    const first = await sweepDeadRelayShards('self', new Set());
    const second = await sweepDeadRelayShards('self', first.suspects);

    expect(second.reaped.sort()).toEqual(['agent-command-relay', 'agent-command-relay-dead']);
    expect(second.suspects.size).toBe(0);
    const drained = vi.mocked(createInstrumentedQueue).mock.calls.map((c) => c[0]).sort();
    expect(drained).toEqual(['agent-command-relay', 'agent-command-relay-dead']);
  });

  it('a suspect whose owner came back is neither removed nor kept as a suspect', async () => {
    redisMock.exists.mockResolvedValue(1);
    const result = await sweepDeadRelayShards('self', new Set(['agent-command-relay-dead']));

    expect(result.reaped).toEqual([]);
    // Only the legacy queue (first sight, no owner key by design) is suspected.
    expect([...result.suspects]).toEqual(['agent-command-relay']);
  });

  it('a liveness read error keeps a suspect alive', async () => {
    redisMock.exists.mockRejectedValue(new Error('down'));
    const result = await sweepDeadRelayShards('self', new Set(['agent-command-relay-dead']));

    expect(result.reaped).toEqual([]);
  });

  it('one shard failing to drain does not stop the rest, and stays a suspect for the next sweep', async () => {
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = fakeQueue();
      if (name === 'agent-command-relay-dead') q.obliterate.mockRejectedValueOnce(new Error('busy'));
      return q;
    }) as never);

    const result = await sweepDeadRelayShards(
      'self', new Set(['agent-command-relay-dead', 'agent-command-relay']),
    );

    expect(result.reaped).toEqual(['agent-command-relay']);
    expect([...result.suspects]).toEqual(['agent-command-relay-dead']);
  });

  it('ignores names that are not relay queues (an id that cannot be a shard)', async () => {
    redisMock.scan.mockResolvedValue(['0', ['bull:agent-command-relay-a:b:meta', 'bull:agent-command-relayx:meta']]);
    const result = await sweepDeadRelayShards('self', new Set(['agent-command-relay-a:b', 'agent-command-relayx']));

    expect(result.reaped).toEqual([]);
    expect(result.suspects.size).toBe(0);
    expect(redisMock.exists).not.toHaveBeenCalled();
  });
});
