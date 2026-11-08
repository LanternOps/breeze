import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #4134 — lifecycle of the per-instance relay consumer: it takes its shard's
// owner key before it consumes (and refuses a shard someone else holds), keeps
// the key fresh, stops if the key is taken from it, drains its shard on
// shutdown, and sweeps shards left by instances that are gone. The shard
// primitives are mocked; their Redis behaviour is covered by
// agentCommandRelayShard.test.ts and the shards integration suite.

vi.mock('../services/instanceIdentity', () => ({ INSTANCE_ID: 'inst-1' }));

const workers: Array<{ name: string; close: ReturnType<typeof vi.fn> }> = [];
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function (this: { name: string; close: unknown }, name: string) {
    this.name = name;
    this.close = vi.fn().mockResolvedValue(undefined);
    workers.push(this as never);
  }),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/workerReadinessRegistry', () => ({
  workerReadinessRegistry: { recordInitializationFailure: vi.fn() },
}));
vi.mock('../services/agentPresence', () => ({ readAgentPresence: vi.fn() }));
vi.mock('../routes/agentWs', () => ({ isAgentConnected: vi.fn(), sendCommandToAgent: vi.fn() }));
vi.mock('../services/agentCommandRelay', () => ({
  agentCommandRelayQueueName: (id: string) => `agent-command-relay-${id}`,
  claimRelaySend: vi.fn(),
  markRelaySendComplete: vi.fn(),
  openRelayCommand: vi.fn(),
  writeRelayAck: vi.fn(),
}));
vi.mock('../services/agentCommandRelayShard', () => ({
  RELAY_SHARD_REFRESH_INTERVAL_MS: 10_000,
  RELAY_SHARD_SWEEP_INTERVAL_MS: 300_000,
  acquireRelayShard: vi.fn(),
  refreshRelayShard: vi.fn(),
  releaseRelayShard: vi.fn(),
  drainRelayQueue: vi.fn(),
  sweepDeadRelayShards: vi.fn(),
}));

import { Worker } from 'bullmq';
import { attachWorkerObservability } from './workerObservability';
import { captureException } from '../services/sentry';
import { workerReadinessRegistry } from '../services/workerReadinessRegistry';
import {
  acquireRelayShard,
  drainRelayQueue,
  refreshRelayShard,
  releaseRelayShard,
  sweepDeadRelayShards,
} from '../services/agentCommandRelayShard';
import {
  initializeAgentCommandRelayWorker,
  RelayShardConflictError,
  shutdownAgentCommandRelayWorker,
} from './agentCommandRelayWorker';

const UUID = /^[0-9a-f-]{36}$/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  workers.length = 0;
  vi.mocked(acquireRelayShard).mockResolvedValue('acquired');
  vi.mocked(refreshRelayShard).mockResolvedValue('refreshed');
  vi.mocked(releaseRelayShard).mockResolvedValue(true);
  vi.mocked(drainRelayQueue).mockResolvedValue(0);
  vi.mocked(sweepDeadRelayShards).mockResolvedValue({ suspects: new Set(), reaped: [] });
});

afterEach(async () => {
  await shutdownAgentCommandRelayWorker();
  vi.useRealTimers();
});

describe('initializeAgentCommandRelayWorker', () => {
  it('takes the shard owner key, then consumes ONLY this instance\'s shard queue', async () => {
    await initializeAgentCommandRelayWorker();

    expect(acquireRelayShard).toHaveBeenCalledWith('inst-1', expect.stringMatching(UUID));
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(workers[0]?.name).toBe('agent-command-relay-inst-1');
    expect(vi.mocked(acquireRelayShard).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(Worker).mock.invocationCallOrder[0]!);
    expect(attachWorkerObservability).toHaveBeenCalledWith(workers[0], 'agentCommandRelay');
  });

  it('refuses to start a second consumer on a shard another consumer holds — no Worker, no timers', async () => {
    vi.mocked(acquireRelayShard).mockResolvedValue('held');

    await expect(initializeAgentCommandRelayWorker()).rejects.toBeInstanceOf(RelayShardConflictError);
    await expect(initializeAgentCommandRelayWorker()).rejects.toThrow(/agent-command-relay-inst-1/);

    expect(Worker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(refreshRelayShard).not.toHaveBeenCalled();
    expect(sweepDeadRelayShards).not.toHaveBeenCalled();
  });

  it('refuses a second start in the same process', async () => {
    await initializeAgentCommandRelayWorker();
    await expect(initializeAgentCommandRelayWorker()).rejects.toBeInstanceOf(RelayShardConflictError);
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(acquireRelayShard).toHaveBeenCalledTimes(1);
  });

  it('Redis unavailable at boot: starts anyway, and the refresh loop takes the key once Redis answers', async () => {
    vi.mocked(acquireRelayShard).mockResolvedValue('unavailable');
    vi.mocked(refreshRelayShard).mockResolvedValueOnce('unavailable').mockResolvedValueOnce('reacquired');

    await initializeAgentCommandRelayWorker();
    expect(Worker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshRelayShard).toHaveBeenCalledTimes(2);
    expect(workers[0]?.close).not.toHaveBeenCalled();
  });

  it('keeps the owner key fresh with the same token it acquired', async () => {
    await initializeAgentCommandRelayWorker();
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];

    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshRelayShard).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(refreshRelayShard).mock.calls) expect(call).toEqual(['inst-1', token]);
  });

  it('a shard taken over by another consumer stops this one, loudly, and its shutdown leaves the shard alone', async () => {
    vi.mocked(refreshRelayShard).mockResolvedValue('lost');
    await initializeAgentCommandRelayWorker();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(workers[0]?.close).toHaveBeenCalledTimes(1);
    expect(workerReadinessRegistry.recordInitializationFailure)
      .toHaveBeenCalledWith('agentCommandRelay', expect.any(RelayShardConflictError));
    expect(captureException).toHaveBeenCalledWith(expect.any(RelayShardConflictError));

    // No further refreshes once stopped.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshRelayShard).toHaveBeenCalledTimes(1);

    await shutdownAgentCommandRelayWorker();
    expect(drainRelayQueue).not.toHaveBeenCalled();
    expect(releaseRelayShard).not.toHaveBeenCalled();
  });
});

describe('shard sweep loop', () => {
  it('sweeps once at start and then every interval, carrying the suspects forward', async () => {
    const firstSuspects = new Set(['agent-command-relay-dead']);
    vi.mocked(sweepDeadRelayShards)
      .mockResolvedValueOnce({ suspects: firstSuspects, reaped: [] })
      .mockResolvedValue({ suspects: new Set(), reaped: ['agent-command-relay-dead'] });

    await initializeAgentCommandRelayWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepDeadRelayShards).toHaveBeenCalledTimes(1);
    expect(sweepDeadRelayShards).toHaveBeenLastCalledWith('inst-1', new Set());

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweepDeadRelayShards).toHaveBeenCalledTimes(2);
    expect(sweepDeadRelayShards).toHaveBeenLastCalledWith('inst-1', firstSuspects);
  });

  it('a failed sweep is logged and keeps the previous suspects for the next one', async () => {
    const suspects = new Set(['agent-command-relay-dead']);
    vi.mocked(sweepDeadRelayShards)
      .mockResolvedValueOnce({ suspects, reaped: [] })
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValue({ suspects: new Set(), reaped: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await initializeAgentCommandRelayWorker();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sweepDeadRelayShards).toHaveBeenCalledTimes(3);
    expect(sweepDeadRelayShards).toHaveBeenLastCalledWith('inst-1', suspects);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('sweep'), expect.any(Error));
    err.mockRestore();
  });
});

describe('shutdownAgentCommandRelayWorker (drain path)', () => {
  it('closes the consumer, then drains its own shard, then releases the owner key — in that order', async () => {
    await initializeAgentCommandRelayWorker();
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];
    const worker = workers[0]!;

    await shutdownAgentCommandRelayWorker();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(drainRelayQueue).toHaveBeenCalledWith('agent-command-relay-inst-1');
    expect(releaseRelayShard).toHaveBeenCalledWith('inst-1', token);
    expect(worker.close.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(drainRelayQueue).mock.invocationCallOrder[0]!);
    expect(vi.mocked(drainRelayQueue).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(releaseRelayShard).mock.invocationCallOrder[0]!);
  });

  it('stops the refresh and sweep timers', async () => {
    await initializeAgentCommandRelayWorker();
    await vi.advanceTimersByTimeAsync(0);
    await shutdownAgentCommandRelayWorker();
    vi.mocked(refreshRelayShard).mockClear();
    vi.mocked(sweepDeadRelayShards).mockClear();

    await vi.advanceTimersByTimeAsync(600_000);

    expect(refreshRelayShard).not.toHaveBeenCalled();
    expect(sweepDeadRelayShards).not.toHaveBeenCalled();
  });

  it('a drain failure is logged, the key is still released, and shutdown does not throw (the sweep removes the shard later)', async () => {
    vi.mocked(drainRelayQueue).mockRejectedValueOnce(new Error('redis gone'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await initializeAgentCommandRelayWorker();

    await expect(shutdownAgentCommandRelayWorker()).resolves.toBeUndefined();

    expect(releaseRelayShard).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('drain'), expect.any(Error));
    err.mockRestore();
  });

  it('is a no-op when nothing was started, and the consumer can start again after a shutdown', async () => {
    await shutdownAgentCommandRelayWorker();
    expect(drainRelayQueue).not.toHaveBeenCalled();

    await initializeAgentCommandRelayWorker();
    await shutdownAgentCommandRelayWorker();
    await initializeAgentCommandRelayWorker();
    expect(Worker).toHaveBeenCalledTimes(2);
  });
});
