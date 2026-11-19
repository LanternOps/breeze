import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #4134 — lifecycle of the per-instance relay consumer: it takes its shard's
// owner key (before serving, or at initialize) and refuses a shard someone
// else holds, keeps the key fresh, stops if the key is taken from it, drains
// its shard on shutdown, and sweeps the queues of instances that are gone. The
// shard primitives are mocked; their Redis behaviour is covered by
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
  claimAgentCommandRelayShard,
  initializeAgentCommandRelayWorker,
  RelayShardConflictError,
  releaseAgentCommandRelayClaim,
  shutdownAgentCommandRelayWorker,
} from './agentCommandRelayWorker';

const UUID = /^[0-9a-f-]{36}$/;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  workers.length = 0;
  vi.mocked(acquireRelayShard).mockResolvedValue('acquired');
  vi.mocked(refreshRelayShard).mockResolvedValue('refreshed');
  vi.mocked(releaseRelayShard).mockResolvedValue(true);
  vi.mocked(drainRelayQueue).mockResolvedValue({ removed: true, acked: 0 });
  vi.mocked(sweepDeadRelayShards).mockResolvedValue({ suspects: new Set(), reaped: [] });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await shutdownAgentCommandRelayWorker().catch(() => {});
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not take the owner key'));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshRelayShard).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was absent'));
    expect(workers[0]?.close).not.toHaveBeenCalled();
  });

  it('keeps the owner key fresh with the same token it acquired', async () => {
    await initializeAgentCommandRelayWorker();
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];

    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshRelayShard).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(refreshRelayShard).mock.calls) expect(call).toEqual(['inst-1', token]);
  });

  it('a start that fails after taking the key releases it and stops refreshing; the next start takes it again', async () => {
    vi.mocked(attachWorkerObservability).mockImplementationOnce(() => { throw new Error('attach failed'); });

    await expect(initializeAgentCommandRelayWorker()).rejects.toThrow('attach failed');
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];
    expect(workers[0]?.close).toHaveBeenCalledTimes(1);
    expect(releaseRelayShard).toHaveBeenCalledWith('inst-1', token);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshRelayShard).not.toHaveBeenCalled();

    await initializeAgentCommandRelayWorker();
    expect(acquireRelayShard).toHaveBeenCalledTimes(2);
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  it('a shard taken over by another consumer stops this one first, then reports it; shutdown leaves the shard alone', async () => {
    vi.mocked(refreshRelayShard).mockResolvedValue('lost');
    await initializeAgentCommandRelayWorker();

    await vi.advanceTimersByTimeAsync(10_000);

    const worker = workers[0]!;
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(worker.close.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(workerReadinessRegistry.recordInitializationFailure).mock.invocationCallOrder[0]!);
    expect(workerReadinessRegistry.recordInitializationFailure)
      .toHaveBeenCalledWith('agentCommandRelay', expect.any(RelayShardConflictError));
    expect(captureException).toHaveBeenCalledWith(expect.any(RelayShardConflictError));

    // No further refreshes once stopped, and no restart in this process.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshRelayShard).toHaveBeenCalledTimes(1);
    await expect(initializeAgentCommandRelayWorker()).rejects.toThrow(/taken by another consumer/);

    await shutdownAgentCommandRelayWorker();
    expect(drainRelayQueue).not.toHaveBeenCalled();
    expect(releaseRelayShard).not.toHaveBeenCalled();
  });

  it('a reporting failure on a lost shard is logged and never escapes as an unhandled rejection', async () => {
    vi.mocked(refreshRelayShard).mockResolvedValue('lost');
    vi.mocked(workerReadinessRegistry.recordInitializationFailure).mockImplementationOnce(() => {
      throw new Error('Worker readiness consumer was not expected');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await initializeAgentCommandRelayWorker();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(workers[0]?.close).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('reporting the lost relay shard failed'), expect.any(Error));
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('claimAgentCommandRelayShard (before serving)', () => {
  it('takes and refreshes the key before any consumer exists; initialize then reuses the claim', async () => {
    await claimAgentCommandRelayShard();
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];
    expect(Worker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshRelayShard).toHaveBeenCalledWith('inst-1', token);

    await initializeAgentCommandRelayWorker();
    expect(acquireRelayShard).toHaveBeenCalledTimes(1);
    expect(workers[0]?.name).toBe('agent-command-relay-inst-1');
  });

  it('a held shard does not throw at claim time; initialize refuses it', async () => {
    vi.mocked(acquireRelayShard).mockResolvedValue('held');

    await expect(claimAgentCommandRelayShard()).resolves.toBeUndefined();
    await expect(initializeAgentCommandRelayWorker()).rejects.toBeInstanceOf(RelayShardConflictError);
    expect(Worker).not.toHaveBeenCalled();
  });

  it('releaseAgentCommandRelayClaim gives up a claim no consumer will use, after any refresh in flight', async () => {
    let finishRefresh: (value: 'refreshed') => void = () => {};
    vi.mocked(refreshRelayShard).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    await claimAgentCommandRelayShard();
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];
    await vi.advanceTimersByTimeAsync(10_000); // a refresh is now in flight

    const released = releaseAgentCommandRelayClaim();
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseRelayShard).not.toHaveBeenCalled();
    finishRefresh('refreshed');
    await released;

    expect(releaseRelayShard).toHaveBeenCalledWith('inst-1', token);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshRelayShard).toHaveBeenCalledTimes(1);
    // Nothing left to drain at shutdown.
    await shutdownAgentCommandRelayWorker();
    expect(drainRelayQueue).not.toHaveBeenCalled();
  });

  it('releaseAgentCommandRelayClaim is a no-op once a consumer runs', async () => {
    await initializeAgentCommandRelayWorker();
    await releaseAgentCommandRelayClaim();
    expect(releaseRelayShard).not.toHaveBeenCalled();
    expect(workers[0]?.close).not.toHaveBeenCalled();
  });

  it('a claim whose consumer never started is still released and drained at shutdown', async () => {
    await claimAgentCommandRelayShard();
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];

    await shutdownAgentCommandRelayWorker();

    expect(releaseRelayShard).toHaveBeenCalledWith('inst-1', token);
    expect(drainRelayQueue).toHaveBeenCalledWith('agent-command-relay-inst-1');
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
    expect(sweepDeadRelayShards).toHaveBeenLastCalledWith('inst-1', new Set(), expect.any(Function));

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweepDeadRelayShards).toHaveBeenCalledTimes(2);
    expect(sweepDeadRelayShards).toHaveBeenLastCalledWith('inst-1', firstSuspects, expect.any(Function));
  });

  it('a failed sweep is logged and keeps the previous suspects for the next one', async () => {
    const suspects = new Set(['agent-command-relay-dead']);
    vi.mocked(sweepDeadRelayShards)
      .mockResolvedValueOnce({ suspects, reaped: [] })
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValue({ suspects: new Set(), reaped: [] });

    await initializeAgentCommandRelayWorker();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sweepDeadRelayShards).toHaveBeenCalledTimes(3);
    expect(sweepDeadRelayShards).toHaveBeenLastCalledWith('inst-1', suspects, expect.any(Function));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sweep'), expect.any(Error));
  });

  it('the sweep is told to stop once shutdown begins', async () => {
    let shouldStop: (() => boolean) | undefined;
    vi.mocked(sweepDeadRelayShards).mockImplementation(async (_self, _prev, stop) => {
      shouldStop = stop;
      return { suspects: new Set(), reaped: [] };
    });

    await initializeAgentCommandRelayWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(shouldStop?.()).toBe(false);

    await shutdownAgentCommandRelayWorker();
    expect(shouldStop?.()).toBe(true);
  });
});

describe('shutdownAgentCommandRelayWorker (drain path)', () => {
  it('releases the owner key, then closes the consumer, then drains its own shard — in that order', async () => {
    await initializeAgentCommandRelayWorker();
    const token = vi.mocked(acquireRelayShard).mock.calls[0]?.[1];
    const worker = workers[0]!;

    await shutdownAgentCommandRelayWorker();

    expect(releaseRelayShard).toHaveBeenCalledWith('inst-1', token);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(drainRelayQueue).toHaveBeenCalledWith('agent-command-relay-inst-1');
    expect(vi.mocked(releaseRelayShard).mock.invocationCallOrder[0])
      .toBeLessThan(worker.close.mock.invocationCallOrder[0]!);
    expect(worker.close.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(drainRelayQueue).mock.invocationCallOrder[0]!);
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

  it('a drain failure is logged and shutdown does not throw (a sweep removes the queue later)', async () => {
    vi.mocked(drainRelayQueue).mockRejectedValueOnce(new Error('redis gone'));
    await initializeAgentCommandRelayWorker();

    await expect(shutdownAgentCommandRelayWorker()).resolves.toBeUndefined();

    expect(releaseRelayShard).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('drain'), expect.any(Error));
  });

  it('a failed close still drains the shard, then the close error is thrown', async () => {
    await initializeAgentCommandRelayWorker();
    workers[0]!.close.mockRejectedValueOnce(new Error('close failed'));

    await expect(shutdownAgentCommandRelayWorker()).rejects.toThrow('close failed');
    expect(drainRelayQueue).toHaveBeenCalledWith('agent-command-relay-inst-1');
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
