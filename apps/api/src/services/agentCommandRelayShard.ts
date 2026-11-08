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
 *     queue did. The key is also the shard's liveness record.
 *   - The drain: ack every job that never started `owner_mismatch` (the claim
 *     was never taken, so nothing was sent and the caller may re-route), then
 *     obliterate the queue so none of its keys outlive it.
 *   - The sweep: INSTANCE_ID changes on every boot, so every restart leaves a
 *     queue behind. A graceful shutdown drains its own; a crash cannot. Live
 *     consumers remove a shard whose owner key is absent on two consecutive
 *     sweeps, and the pre-#4134 shared queue the same way. Without this, each
 *     crash would leave a BullMQ event stream and its jobs in a `noeviction`
 *     Redis for good.
 */
import { getRedis } from './redis';
import { createInstrumentedQueue } from './bullmqQueue';
import {
  relayInstanceIdFromQueueName,
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

export function relayShardOwnerKey(instanceId: string): string {
  return `agent-relay-shard:${instanceId}`;
}

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
  } catch {
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
  } catch {
    return 'unavailable';
  }
}

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Remove the owner key, only while it still holds `token`. */
export async function releaseRelayShard(instanceId: string, token: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.eval(RELEASE_LUA, 1, relayShardOwnerKey(instanceId), token)) === 1;
}

/** Whether a consumer owns the shard. A failed read counts as live: never reap on doubt. */
export async function isRelayShardLive(instanceId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    return (await redis.exists(relayShardOwnerKey(instanceId))) === 1;
  } catch {
    return true;
  }
}

/**
 * Empty and remove one relay queue. Jobs that never started are acked
 * `owner_mismatch` first so a producer still waiting gets an answer instead
 * of timing out. Active jobs are not acked: one may be mid-send, and its own
 * consumer writes the true outcome. Returns the number of acks written.
 * Throws if the queue could not be removed.
 */
export async function drainRelayQueue(queueName: string): Promise<number> {
  // skipMetasUpdate: this handle exists to remove the queue, so it must not
  // write the queue's meta hash back on construction.
  const queue = createInstrumentedQueue<RelayJobData>(queueName, { skipMetasUpdate: true });
  try {
    let acked = 0;
    const jobs = await queue.getJobs(['waiting', 'prioritized', 'paused', 'delayed'], 0, RELAY_DRAIN_MAX_ACKS - 1);
    for (const job of jobs) {
      const relayId = job?.data?.relayId;
      if (typeof relayId !== 'string' || relayId.length === 0) continue;
      try {
        await writeRelayAck(relayId, { status: 'owner_mismatch' });
        acked += 1;
      } catch (err) {
        // The producer times out to `indeterminate` instead; the queue must still go.
        console.warn(`[AgentRelayShard] ack for relay ${relayId} on ${queueName} failed:`, err);
      }
    }
    await queue.obliterate({ force: true });
    return acked;
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
  suspects: Set<string>;
  /** Queues removed this sweep. */
  reaped: string[];
}

/**
 * One cleanup pass. A queue is removed only when it was ownerless on the
 * previous pass too, so a shard whose consumer is still starting (its owner
 * key not yet written) or briefly lost Redis is never touched. The caller's
 * own shard is always skipped. A queue that fails to drain stays a suspect.
 */
export async function sweepDeadRelayShards(
  selfInstanceId: string,
  previousSuspects: ReadonlySet<string>,
): Promise<RelayShardSweepResult> {
  const suspects = new Set<string>();
  const reaped: string[] = [];
  for (const name of await listRelayQueueNames()) {
    const owner = relayInstanceIdFromQueueName(name);
    if (owner === undefined || owner === selfInstanceId) continue;
    // The legacy shared queue has no owner key: nothing enqueues on it any more.
    if (owner !== null && await isRelayShardLive(owner)) continue;
    if (!previousSuspects.has(name)) {
      suspects.add(name);
      continue;
    }
    try {
      const acked = await drainRelayQueue(name);
      reaped.push(name);
      console.log(`[AgentRelayShard] removed relay queue ${name} with no live consumer (${acked} waiting job(s) acked owner_mismatch)`);
    } catch (err) {
      suspects.add(name);
      console.error(`[AgentRelayShard] removing relay queue ${name} with no live consumer failed; retrying next sweep:`, err);
    }
  }
  return { suspects, reaped };
}
