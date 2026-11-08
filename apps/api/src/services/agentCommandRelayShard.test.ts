import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4134 — per-instance relay shards: the owner key that refuses a second
// consumer on one shard, the drain that empties a shard, and the sweep that
// removes queues whose instance is gone. Redis is a hand-rolled fake here; the
// owner-key Lua scripts and real BullMQ removal run against real Redis in
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
import { __resetRelayRedisFailureLogForTests, relayShardOwnerKey } from './agentCommandRelay';
import {
  acquireRelayShard,
  drainRelayQueue,
  listRelayQueueNames,
  RELAY_DRAIN_MAX_ACKS,
  RELAY_SHARD_OWNER_TTL_MS,
  refreshRelayShard,
  releaseRelayShard,
  sweepDeadRelayShards,
} from './agentCommandRelayShard';

type FakeQueue = {
  getWorkersCount: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  getJobs: ReturnType<typeof vi.fn>;
  obliterate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeQueue(jobs: unknown[] = [], workers = 0): FakeQueue {
  return {
    getWorkersCount: vi.fn().mockResolvedValue(workers),
    pause: vi.fn().mockResolvedValue(undefined),
    getJobs: vi.fn().mockResolvedValue(jobs),
    obliterate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRelayRedisFailureLogForTests();
  redisAvailable = true;
  redisMock.set.mockResolvedValue('OK');
  redisMock.exists.mockResolvedValue(0);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('shard owner key (the second-consumer guard)', () => {
  it('acquire takes the key only when absent, with the owner TTL', async () => {
    redisMock.set.mockResolvedValueOnce('OK');
    await expect(acquireRelayShard('inst-1', 'tok-1')).resolves.toBe('acquired');
    expect(redisMock.set).toHaveBeenCalledWith(
      relayShardOwnerKey('inst-1'), 'tok-1', 'PX', RELAY_SHARD_OWNER_TTL_MS, 'NX',
    );
  });

  it('acquire reports held when another consumer already owns the shard', async () => {
    redisMock.set.mockResolvedValueOnce(null);
    await expect(acquireRelayShard('inst-1', 'tok-2')).resolves.toBe('held');
  });

  it('acquire reports unavailable (never held) when Redis errors, and says why', async () => {
    redisMock.set.mockRejectedValueOnce(new Error('NOAUTH'));
    await expect(acquireRelayShard('inst-1', 'tok-1')).resolves.toBe('unavailable');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner key acquire failed'), 'NOAUTH');
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

  it('refresh on a Redis error is unavailable, not lost, and is logged rate-limited', async () => {
    redisMock.eval.mockRejectedValue(new Error('timeout'));
    await expect(refreshRelayShard('inst-1', 'tok-1')).resolves.toBe('unavailable');
    await expect(refreshRelayShard('inst-1', 'tok-1')).resolves.toBe('unavailable');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner key refresh failed'), 'timeout');
  });

  it('release deletes only a key that still holds this token', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(releaseRelayShard('inst-1', 'tok-1')).resolves.toBe(true);
    await expect(releaseRelayShard('inst-1', 'tok-1')).resolves.toBe(false);
    expect(redisMock.eval.mock.calls[0]?.slice(1)).toEqual([1, 'agent-relay-shard:inst-1', 'tok-1']);
  });
});

describe('drainRelayQueue', () => {
  it('pauses, acks every never-started job owner_mismatch, then obliterates and closes the handle', async () => {
    const queue = fakeQueue([
      { data: { relayId: 'r-1' } },
      { data: { relayId: 'r-2' } },
      { data: {} },
      undefined,
    ]);
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);

    await expect(drainRelayQueue('agent-command-relay-inst-1')).resolves.toEqual({ removed: true, acked: 2 });

    // A handle that never rewrites the queue's meta hash.
    expect(createInstrumentedQueue).toHaveBeenCalledWith('agent-command-relay-inst-1', { skipMetasUpdate: true });
    // Paused before the read, so no consumer can start a job that is then acked.
    expect(queue.pause.mock.invocationCallOrder[0]).toBeLessThan(queue.getJobs.mock.invocationCallOrder[0]!);
    // Bounded, and active jobs are NOT read: one may be mid-send.
    expect(queue.getJobs).toHaveBeenCalledWith(['waiting', 'prioritized', 'paused', 'delayed'], 0, RELAY_DRAIN_MAX_ACKS - 1);
    const ack = JSON.stringify({ status: 'owner_mismatch' });
    expect(redisMock.set).toHaveBeenCalledWith('agent-relay-ack:r-1', ack, 'PX', 30_000);
    expect(redisMock.set).toHaveBeenCalledWith('agent-relay-ack:r-2', ack, 'PX', 30_000);
    expect(redisMock.set).toHaveBeenCalledTimes(2);
    expect(queue.obliterate).toHaveBeenCalledWith({ force: true });
    expect(queue.obliterate.mock.invocationCallOrder[0])
      .toBeGreaterThan(Math.max(...redisMock.set.mock.invocationCallOrder));
    expect(queue.close).toHaveBeenCalledTimes(1);
    // The shutdown drain does not ask about consumers: its own just closed.
    expect(queue.getWorkersCount).not.toHaveBeenCalled();
  });

  it('a failed ack write is counted out and logged, and the queue is still removed', async () => {
    const queue = fakeQueue([{ data: { relayId: 'r-1' } }, { data: { relayId: 'r-2' } }]);
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);
    redisMock.set.mockRejectedValueOnce(new Error('OOM'));

    await expect(drainRelayQueue('agent-command-relay-inst-1')).resolves.toEqual({ removed: true, acked: 1 });
    expect(queue.obliterate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 of 2 owner_mismatch ack(s)'), expect.any(Error));
  });

  it('an obliterate failure propagates, and the handle is still closed', async () => {
    const queue = fakeQueue();
    queue.obliterate.mockRejectedValueOnce(new Error('busy'));
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);

    await expect(drainRelayQueue('agent-command-relay-inst-1')).rejects.toThrow('busy');
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it('skipIfConsumerConnected: a connected Worker leaves the queue untouched — no pause, no acks, no removal', async () => {
    const queue = fakeQueue([{ data: { relayId: 'r-1' } }], 1);
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);

    await expect(drainRelayQueue('agent-command-relay', { skipIfConsumerConnected: true }))
      .resolves.toEqual({ removed: false, reason: 'consumer_connected' });
    expect(queue.pause).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(queue.obliterate).not.toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it('skipIfConsumerConnected: an unanswerable consumer lookup also leaves the queue alone', async () => {
    const queue = fakeQueue();
    queue.getWorkersCount.mockRejectedValueOnce(new Error('ERR unknown command CLIENT'));
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);

    await expect(drainRelayQueue('agent-command-relay-x', { skipIfConsumerConnected: true }))
      .resolves.toEqual({ removed: false, reason: 'consumer_check_failed' });
    expect(queue.obliterate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('consumer lookup failed'), 'ERR unknown command CLIENT');
  });

  it('skipIfConsumerConnected with no Worker connected removes the queue', async () => {
    const queue = fakeQueue([], 0);
    vi.mocked(createInstrumentedQueue).mockReturnValue(queue as never);

    await expect(drainRelayQueue('agent-command-relay-x', { skipIfConsumerConnected: true }))
      .resolves.toEqual({ removed: true, acked: 0 });
    expect(queue.obliterate).toHaveBeenCalledTimes(1);
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
  let queuesByName: Map<string, FakeQueue>;

  beforeEach(() => {
    queuesByName = new Map();
    redisMock.scan.mockResolvedValue(['0', META]);
    redisMock.exists.mockImplementation(async (key: string) => (key === 'agent-relay-shard:live' ? 1 : 0));
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = fakeQueue();
      queuesByName.set(name, q);
      return q;
    }) as never);
  });

  it('first sight only marks ownerless queues (and the legacy queue) as suspects; it removes nothing', async () => {
    const result = await sweepDeadRelayShards('self', new Set());

    expect(result.reaped).toEqual([]);
    expect([...result.suspects].sort()).toEqual(['agent-command-relay', 'agent-command-relay-dead']);
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
    // Never asks whether its own shard is live.
    expect(redisMock.exists).not.toHaveBeenCalledWith('agent-relay-shard:self');
  });

  it('a queue still ownerless on the next sweep, with no Worker connected, is removed; live and own shards never are', async () => {
    const first = await sweepDeadRelayShards('self', new Set());
    const second = await sweepDeadRelayShards('self', first.suspects);

    expect(second.reaped.sort()).toEqual(['agent-command-relay', 'agent-command-relay-dead']);
    expect(second.suspects.size).toBe(0);
    expect([...queuesByName.keys()].sort()).toEqual(['agent-command-relay', 'agent-command-relay-dead']);
    for (const q of queuesByName.values()) {
      expect(q.getWorkersCount).toHaveBeenCalledTimes(1);
      expect(q.obliterate).toHaveBeenCalledTimes(1);
    }
  });

  it('an ownerless queue with a Worker still connected (an older build, or a lapsed key) is kept as a suspect', async () => {
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = fakeQueue([], name === 'agent-command-relay' ? 1 : 0);
      queuesByName.set(name, q);
      return q;
    }) as never);

    const result = await sweepDeadRelayShards('self', new Set(['agent-command-relay', 'agent-command-relay-dead']));

    expect(result.reaped).toEqual(['agent-command-relay-dead']);
    expect([...result.suspects]).toEqual(['agent-command-relay']);
    expect(queuesByName.get('agent-command-relay')?.obliterate).not.toHaveBeenCalled();
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

  it('one queue failing to drain does not stop the rest, and stays a suspect for the next sweep', async () => {
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

  it('stops before the next queue once shouldStop says so', async () => {
    let calls = 0;
    const result = await sweepDeadRelayShards('self', new Set(['agent-command-relay-dead']), () => calls++ >= 1);

    // Only the first name (its own shard, skipped) was looked at.
    expect(result.reaped).toEqual([]);
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
  });

  it('ignores names that are not relay queues (an id that cannot be a shard)', async () => {
    redisMock.scan.mockResolvedValue(['0', ['bull:agent-command-relay-a:b:meta', 'bull:agent-command-relayx:meta']]);
    const result = await sweepDeadRelayShards('self', new Set(['agent-command-relay-a:b', 'agent-command-relayx']));

    expect(result.reaped).toEqual([]);
    expect(result.suspects.size).toBe(0);
    expect(redisMock.exists).not.toHaveBeenCalled();
  });
});
