import { randomUUID } from 'crypto';
import { Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { INSTANCE_ID } from '../services/instanceIdentity';
import { readAgentPresence } from '../services/agentPresence';
import { captureException } from '../services/sentry';
import { workerReadinessRegistry } from '../services/workerReadinessRegistry';
import {
  agentCommandRelayQueueName,
  claimRelaySend,
  markRelaySendComplete,
  openRelayCommand,
  writeRelayAck,
  type DispatchOutcome,
  type RelayJobData,
} from '../services/agentCommandRelay';
import {
  RELAY_SHARD_REFRESH_INTERVAL_MS,
  RELAY_SHARD_SWEEP_INTERVAL_MS,
  acquireRelayShard,
  drainRelayQueue,
  refreshRelayShard,
  releaseRelayShard,
  sweepDeadRelayShards,
} from '../services/agentCommandRelayShard';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';

const READINESS_NAME = 'agentCommandRelay';

/**
 * Api-role relay consumer (wave 3.5b, #4084).
 *
 * Runs ONLY on a process that may own sockets — registration in index.ts is
 * gated on `breezeRole() !== 'worker'`. It consumes only this instance's own
 * shard, `agent-command-relay-<INSTANCE_ID>` (#4134), so every job it sees was
 * routed here by a presence lease naming this instance. Presence merely
 * ADMITTED this job onto the queue; this process's in-memory socket map
 * (agentWs.isAgentConnected) is the actual authority for whether the send can
 * happen at all, and the lease/target-instance checks below re-verify the
 * routing decision wasn't made against a since-superseded lease. Those checks
 * are the fallback for a lease that moved after the job was built: the job
 * acks `owner_mismatch` and nothing is sent.
 *
 * The local send path also records the orphaned-result expectation (the
 * dispatch record that authorizes the eventual `command_result`), which is why
 * this consumer calls `sendCommandToAgent` directly and never re-implements the
 * socket write itself. That record lives in Redis (#4135), so the result is
 * honored on whichever replica the agent is connected to when it replies.
 */
export async function processAgentCommandRelayJob(job: Job<RelayJobData>): Promise<void> {
  const d = job.data;
  const ack = (outcome: DispatchOutcome) => writeRelayAck(d.relayId, outcome);

  if (Date.now() > d.expiresAt) return ack({ status: 'expired' });
  if (!isAgentConnected(d.agentId)) return ack({ status: 'offline' });

  const lease = await readAgentPresence(d.agentId);
  if (
    !lease
    || lease.instanceId !== d.targetInstanceId
    || lease.connectionToken !== d.connectionToken
    || d.targetInstanceId !== INSTANCE_ID
  ) {
    return ack({ status: 'owner_mismatch' });
  }

  let claim: Awaited<ReturnType<typeof claimRelaySend>>;
  try {
    claim = await claimRelaySend(d.agentId, d.commandId);
  } catch (err) {
    return ack({
      status: 'infrastructure_error',
      message: `send claim failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (claim === 'already-sent') return ack({ status: 'sent', via: 'relay' });
  if (claim === 'in-flight') return ack({ status: 'indeterminate' });

  let command;
  try {
    command = openRelayCommand(d.sealedCommand, {
      agentId: d.agentId, commandId: d.commandId,
      targetInstanceId: d.targetInstanceId, expiresAt: d.expiresAt,
    });
  } catch {
    return ack({ status: 'infrastructure_error', message: 'relay envelope failed to open (tamper or key mismatch)' });
  }

  if (!sendCommandToAgent(d.agentId, command)) return ack({ status: 'offline' });
  await markRelaySendComplete(d.agentId, d.commandId);
  return ack({ status: 'sent', via: 'relay' });
}

/**
 * Thrown when a consumer would share a shard with another one: at start, when
 * the shard's owner key is already held, and at runtime, when the refresh
 * finds the key taken by another consumer.
 */
export class RelayShardConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayShardConflictError';
  }
}

/** Builds a Worker on THIS instance's shard. The ownership guard lives in initialize. */
export function createAgentCommandRelayWorker(): Worker<RelayJobData> {
  return new Worker<RelayJobData>(agentCommandRelayQueueName(INSTANCE_ID), processAgentCommandRelayJob, {
    connection: getBullMQConnection(),
    // ws.send is fast; 25 is deliberately conservative — tune from queue-age
    // measurements after 3.5d rolls out, mirroring eventDispatchWorker's note.
    concurrency: 25,
  });
}

interface RelayConsumerState {
  queueName: string;
  /** Per-start token held in the shard owner key; fences refresh and release. */
  token: string;
  worker: Worker<RelayJobData>;
  /** Another consumer took the shard; this one has stopped for good. */
  lost: boolean;
  refreshTimer: ReturnType<typeof setInterval>;
  sweepTimer: ReturnType<typeof setInterval>;
  refreshing: Promise<void> | null;
  sweeping: Promise<void> | null;
  /** Ownerless queues from the last sweep: removed if still ownerless on the next. */
  suspects: Set<string>;
}

let consumer: RelayConsumerState | null = null;
let starting = false;

async function stopOnLostShard(state: RelayConsumerState): Promise<void> {
  state.lost = true;
  clearInterval(state.refreshTimer);
  clearInterval(state.sweepTimer);
  const err = new RelayShardConflictError(
    `relay shard ${state.queueName} was taken by another consumer; this consumer stopped so two consumers never compete for one shard`,
  );
  console.error(`[AgentCommandRelayWorker] ${err.message}`);
  captureException(err);
  workerReadinessRegistry.recordInitializationFailure(READINESS_NAME, err);
  await state.worker.close().catch((closeErr: unknown) => {
    console.error(`[AgentCommandRelayWorker] closing the consumer for ${state.queueName} failed:`, closeErr);
  });
}

function refreshShard(state: RelayConsumerState): void {
  if (state.lost || state.refreshing) return;
  state.refreshing = (async () => {
    const result = await refreshRelayShard(INSTANCE_ID, state.token);
    if (result === 'reacquired') {
      console.warn(`[AgentCommandRelayWorker] owner key for relay shard ${state.queueName} was absent (Redis was unavailable or the key lapsed); taken`);
    } else if (result === 'lost') {
      await stopOnLostShard(state);
    }
    // 'unavailable': keep consuming. The key's TTL outlives several missed
    // refreshes, and a sweep needs two ownerless passes before it removes a shard.
  })().finally(() => { state.refreshing = null; });
}

function sweepShards(state: RelayConsumerState): void {
  if (state.lost || state.sweeping) return;
  state.sweeping = (async () => {
    try {
      const result = await sweepDeadRelayShards(INSTANCE_ID, state.suspects);
      state.suspects = result.suspects;
    } catch (err) {
      console.error('[AgentCommandRelayWorker] relay shard sweep failed; retrying next interval:', err);
    }
  })().finally(() => { state.sweeping = null; });
}

/**
 * Start this instance's relay consumer (#4134). Takes the shard owner key
 * first and refuses to start if another consumer holds it, then consumes the
 * shard, keeps the key fresh, and sweeps shards left by instances that are
 * gone. If Redis cannot answer at start it consumes anyway and the refresh
 * loop takes the key later.
 */
export async function initializeAgentCommandRelayWorker(): Promise<void> {
  const queueName = agentCommandRelayQueueName(INSTANCE_ID);
  if (consumer || starting) {
    throw new RelayShardConflictError(`a relay consumer for ${queueName} is already running in this process`);
  }
  starting = true;
  const token = randomUUID();
  let acquired = false;
  let worker: Worker<RelayJobData> | null = null;
  try {
    const result = await acquireRelayShard(INSTANCE_ID, token);
    if (result === 'held') {
      throw new RelayShardConflictError(
        `relay shard ${queueName} is already owned by another consumer; refusing to start a second consumer on it`,
      );
    }
    acquired = result === 'acquired';
    if (!acquired) {
      console.warn(`[AgentCommandRelayWorker] could not take the owner key for relay shard ${queueName} (Redis unavailable); consuming anyway, the refresh loop takes it once Redis answers`);
    }
    worker = createAgentCommandRelayWorker();
    attachWorkerObservability(worker, READINESS_NAME);
    const state: RelayConsumerState = {
      queueName,
      token,
      worker,
      lost: false,
      refreshTimer: setInterval(() => refreshShard(state), RELAY_SHARD_REFRESH_INTERVAL_MS),
      sweepTimer: setInterval(() => sweepShards(state), RELAY_SHARD_SWEEP_INTERVAL_MS),
      refreshing: null,
      sweeping: null,
      suspects: new Set(),
    };
    state.refreshTimer.unref?.();
    state.sweepTimer.unref?.();
    consumer = state;
    sweepShards(state);
    console.log(`[AgentCommandRelayWorker] Initialized on ${queueName}`);
  } catch (error) {
    if (worker) await worker.close().catch(() => {});
    if (acquired) await releaseRelayShard(INSTANCE_ID, token).catch(() => false);
    console.error('[AgentCommandRelayWorker] Failed to initialize:', error);
    throw error;
  } finally {
    starting = false;
  }
}

/**
 * Drain path (#4134): stop consuming (in-flight sends finish), ack every job
 * still waiting on this shard `owner_mismatch` so its producer can re-route
 * instead of timing out, remove the shard's queue, then release the owner key.
 * A failed drain is logged, not thrown: another instance's sweep removes the
 * shard once its owner key is gone.
 */
export async function shutdownAgentCommandRelayWorker(): Promise<void> {
  const state = consumer;
  if (!state) return;
  consumer = null;
  clearInterval(state.refreshTimer);
  clearInterval(state.sweepTimer);
  await Promise.allSettled([state.refreshing, state.sweeping]);
  // A consumer that lost its shard already stopped, and the shard is not its to drain.
  if (state.lost) return;

  await state.worker.close();
  try {
    const acked = await drainRelayQueue(state.queueName);
    console.log(`[AgentCommandRelayWorker] drained ${state.queueName} on shutdown (${acked} waiting job(s) acked owner_mismatch)`);
  } catch (err) {
    console.error(`[AgentCommandRelayWorker] drain of ${state.queueName} on shutdown failed; a live instance's sweep removes it later:`, err);
  }
  try {
    await releaseRelayShard(INSTANCE_ID, state.token);
  } catch (err) {
    console.warn(`[AgentCommandRelayWorker] releasing the owner key for ${state.queueName} failed; it expires on its own:`, err);
  }
}
