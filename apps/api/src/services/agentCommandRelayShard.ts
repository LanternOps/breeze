/**
 * Per-instance relay shards (#4134): ownership, drain and cleanup.
 *
 * Each socket-owning API instance consumes its own relay queue,
 * `agent-command-relay-<INSTANCE_ID>` (see agentCommandRelay.ts). This module
 * holds the consumer-side lifecycle of those queues:
 *
 *   - The shard owner key `agent-relay-shard:<instanceId>`: a consumer takes
 *     it with SET NX before it starts and refreshes it while it runs. A second
 *     consumer for the same shard finds the key held and refuses to start. Two
 *     consumers on one shard would compete for jobs exactly as the old shared
 *     queue did. Producers read the key too: no key, no consumer, so they
 *     answer `offline` instead of enqueuing.
 *   - The drain: pause the queue, ack every job that never started
 *     `owner_mismatch` (its send claim was never taken, so nothing was sent),
 *     then obliterate the queue, which removes its BullMQ keys.
 *   - The sweep: INSTANCE_ID changes on every boot, so every restart leaves a
 *     queue behind. A graceful shutdown drains its own; a crash cannot. Live
 *     consumers remove a relay queue (a shard, or the pre-#4134 shared queue)
 *     once it has had no owner key on two consecutive sweeps AND no BullMQ
 *     Worker is connected to it. Without this, each crash would leave a BullMQ
 *     event stream and its jobs in a `noeviction` Redis for good.
 *
 * Discovery relies on each queue's `meta` hash: every BullMQ job add writes
 * it, so any queue holding jobs is found. A shard that never received a job
 * holds only the Worker's own expiring keys.
 */
import { getRedis } from './redis';
import { createInstrumentedQueue } from './bullmqQueue';
import {
  isRelayShardLive,
  logRelayRedisFailure,
  relayQueueOwner,
  relayShardOwnerKey,
  writeRelayAck,
  type RelayJobData,
} from './agentCommandRelay';

export const RELAY_SHARD_OWNER_TTL_MS = 30_000;
export const RELAY_SHARD_REFRESH_INTERVAL_MS = 10_000;
export const RELAY_SHARD_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Upper bound on acks one drain writes; the rest of the queue is still removed. */
export const RELAY_DRAIN_MAX_ACKS = 1_000;

// BullMQ's default key prefix. No queue in this codebase sets another one.
const BULLMQ_PREFIX = 'bull';
const RELAY_QUEUE_META_PATTERN = `${BULLMQ_PREFIX}:agent-command-relay*:meta`;
const SCAN_COUNT = 500;

export type RelayShardAcquireResult = 'acquired' | 'held' | 'unavailable';

/**
 * Take the shard for a new consumer. `held` means another consumer owns it.
 * `unavailable` means Redis could not answer: the caller starts anyway and
 * the refresh loop takes the key once Redis is back, because a Redis blip at
 * boot must not leave the instance without a relay consumer until restart.
 */
export async function acquireRelayShard(instanceId: string, token: string): Promise<RelayShardAcquireResult> {
  const redis = getRedis();
  if (!redis) return 'unavailable';
  try {
    const res = await redis.set(relayShardOwnerKey(instanceId), token, 'PX', RELAY_SHARD_OWNER_TTL_MS, 'NX');
    return res === 'OK' ? 'acquired' : 'held';
  } catch (err) {
    logRelayRedisFailure('relay shard owner key acquire', err);
    return 'unavailable';
  }
}

// 1 = still ours, TTL extended; 2 = had lapsed, taken back; 0 = another token.
const REFRESH_LUA = `
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if not v then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 2
end
return 0
`;

export type RelayShardRefreshResult = 'refreshed' | 'reacquired' | 'lost' | 'unavailable';

export async function refreshRelayShard(instanceId: string, token: string): Promise<RelayShardRefreshResult> {
  const redis = getRedis();
  if (!redis) return 'unavailable';
  try {
    const res = await redis.eval(REFRESH_LUA, 1, relayShardOwnerKey(instanceId), token, String(RELAY_SHARD_OWNER_TTL_MS));
    if (res === 1) return 'refreshed';
    if (res === 2) return 'reacquired';
    return 'lost';
  } catch (err) {
    // Logged here, rate-limited: a refresh that keeps failing lets the key
    // lapse, and the producer then answers `offline` for this shard.
    logRelayRedisFailure('relay shard owner key refresh', err);
    return 'unavailable';
  }
}

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Remove the owner key, only while it still holds `token`. Throws on a Redis error. */
export async function releaseRelayShard(instanceId: string, token: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.eval(RELEASE_LUA, 1, relayShardOwnerKey(instanceId), token)) === 1;
}

export type RelayQueueDrainResult =
  | { removed: true; acked: number }
  | { removed: false; reason: 'consumer_connected' | 'consumer_check_failed' };

/**
 * Empty and remove one relay queue. The queue is paused first so no consumer
 * starts a job while it is read. Jobs that never started are then acked
 * `owner_mismatch`, so a producer still waiting gets that answer instead of
 * timing out; any retry is the producer's caller's decision. Active jobs are
 * not acked: on shutdown none remain, and in a sweep they belonged to a
 * consumer that is gone, so their producers have timed out already.
 *
 * `skipIfConsumerConnected` (the sweep) first asks Redis whether any BullMQ
 * Worker is connected to the queue, and leaves the queue alone if one is, or
 * if the answer cannot be had (a Redis that refuses CLIENT LIST never has its
 * queues removed). Throws if the queue could not be removed.
 */
export async function drainRelayQueue(
  queueName: string,
  opts: { skipIfConsumerConnected?: boolean } = {},
): Promise<RelayQueueDrainResult> {
  // skipMetasUpdate: this handle exists to remove the queue, so it must not
  // write the queue's meta hash back on construction.
  const queue = createInstrumentedQueue<RelayJobData>(queueName, { skipMetasUpdate: true });
  try {
    if (opts.skipIfConsumerConnected) {
      let workers: number;
      try {
        workers = await queue.getWorkersCount();
      } catch (err) {
        logRelayRedisFailure('relay queue consumer lookup', err);
        return { removed: false, reason: 'consumer_check_failed' };
      }
      if (workers > 0) return { removed: false, reason: 'consumer_connected' };
    }
    await queue.pause();
    const jobs = await queue.getJobs(['waiting', 'prioritized', 'paused', 'delayed'], 0, RELAY_DRAIN_MAX_ACKS - 1);
    const relayIds = jobs
      .map((job) => job?.data?.relayId)
      .filter((relayId): relayId is string => typeof relayId === 'string' && relayId.length > 0);
    const acks = await Promise.allSettled(
      relayIds.map((relayId) => writeRelayAck(relayId, { status: 'owner_mismatch' })),
    );
    const failed = acks.filter((ack) => ack.status === 'rejected');
    if (failed.length > 0) {
      // Those producers time out to `indeterminate` instead; the queue must still go.
      console.warn(
        `[AgentRelayShard] ${failed.length} of ${relayIds.length} owner_mismatch ack(s) on ${queueName} failed:`,
        (failed[0] as PromiseRejectedResult).reason,
      );
    }
    await queue.obliterate({ force: true });
    return { removed: true, acked: relayIds.length - failed.length };
  } finally {
    await queue.close().catch((err: unknown) => {
      console.warn(`[AgentRelayShard] closing drain handle for ${queueName} failed:`, err);
    });
  }
}

/** Names of every relay queue present in Redis: shards and the legacy shared queue. */
export async function listRelayQueueNames(): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  const names = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', RELAY_QUEUE_META_PATTERN, 'COUNT', SCAN_COUNT);
    for (const key of keys) {
      names.add(key.slice(`${BULLMQ_PREFIX}:`.length, -':meta'.length));
    }
    cursor = next;
  } while (cursor !== '0');
  return [...names];
}

export interface RelayShardSweepResult {
  /** Ownerless queues seen this sweep; removed if still ownerless on the next. */
  suspects: ReadonlySet<string>;
  /** Queues removed this sweep. */
  reaped: string[];
}

/**
 * One cleanup pass. A queue is removed only when it had no owner key on the
 * previous pass too, and no Worker is connected to it now. So a shard whose
 * consumer is still starting, briefly lost Redis, or belongs to an older build
 * that is still running is never touched. The caller's own shard is always
 * skipped. A queue that is not removed stays a suspect. `shouldStop` is
 * checked before each queue, so a shutdown never waits on more than one drain.
 */
export async function sweepDeadRelayShards(
  selfInstanceId: string,
  previousSuspects: ReadonlySet<string>,
  shouldStop: () => boolean = () => false,
): Promise<RelayShardSweepResult> {
  const suspects = new Set<string>();
  const reaped: string[] = [];
  for (const name of await listRelayQueueNames()) {
    if (shouldStop()) break;
    const owner = relayQueueOwner(name);
    if (!owner) continue;
    if (owner.kind === 'shard') {
      if (owner.instanceId === selfInstanceId) continue;
      if (await isRelayShardLive(owner.instanceId)) continue;
    }
    // The legacy shared queue never has an owner key: only the connected-
    // Worker check below protects an older build still consuming it.
    if (!previousSuspects.has(name)) {
      suspects.add(name);
      continue;
    }
    try {
      const result = await drainRelayQueue(name, { skipIfConsumerConnected: true });
      if (result.removed) {
        reaped.push(name);
        console.log(`[AgentRelayShard] removed relay queue ${name}: no owner and no consumer (${result.acked} waiting job(s) acked owner_mismatch)`);
      } else {
        suspects.add(name);
      }
    } catch (err) {
      suspects.add(name);
      console.error(`[AgentRelayShard] removing relay queue ${name} with no owner failed; retrying next sweep:`, err);
    }
  }
  return { suspects, reaped };
}
