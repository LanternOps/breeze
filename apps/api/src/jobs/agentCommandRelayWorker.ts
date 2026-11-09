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
  releaseRelaySendClaim,
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
  } catch (err) {
    // Tamper or a key this instance does not hold: nothing was sent, so the
    // claim goes back (#4142), and the cause is reported here because the ack
    // carries only a fixed message.
    console.error('[AgentCommandRelayWorker] relay envelope failed to open', {
      relayId: d.relayId,
      commandId: d.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
    await releaseRelaySendClaim(d.agentId, d.commandId);
    return ack({ status: 'infrastructure_error', message: 'relay envelope failed to open (tamper or key mismatch)' });
  }

  // Re-checked here, not only on entry (#4142): the presence read and the
  // claim are Redis round trips, and once `expiresAt` passes the producer may
  // already have answered its caller, which then acts on that answer.
  if (Date.now() > d.expiresAt) {
    await releaseRelaySendClaim(d.agentId, d.commandId);
    return ack({ status: 'expired' });
  }

  if (!sendCommandToAgent(d.agentId, command)) {
    // Nothing was sent: give the claim back so a retry of this command can take it.
    await releaseRelaySendClaim(d.agentId, d.commandId);
    return ack({ status: 'offline' });
  }
  await markRelaySendComplete(d.agentId, d.commandId);
  return ack({ status: 'sent', via: 'relay' });
}

/**
 * Thrown by initializeAgentCommandRelayWorker when the shard's owner key is
 * held by another consumer, or a consumer already runs (or lost its shard) in
 * this process. Also the error reported, not thrown, when the refresh finds
 * the key taken by another consumer at runtime.
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

interface RelayConsumer {
  worker: Worker<RelayJobData>;
  sweepTimer: ReturnType<typeof setInterval>;
  sweeping: Promise<void> | null;
  /** Ownerless queues from the last sweep: removed if still ownerless on the next. */
  suspects: ReadonlySet<string>;
}

/**
 * This process's hold on its shard: the owner key (taken before serving) and,
 * once initialize runs, the consumer. Kept after `lost` until shutdown, so a
 * second initialize in the same process is refused rather than retried.
 */
interface RelayShardState {
  queueName: string;
  /** Per-claim token held in the owner key; fences refresh and release. */
  token: string;
  /** Another consumer took the shard. Nothing here consumes or refreshes any more. */
  lost: boolean;
  /** Shutdown has begun. Background work stops at its next check. */
  stopping: boolean;
  refreshTimer: ReturnType<typeof setInterval>;
  refreshing: Promise<void> | null;
  consumer: RelayConsumer | null;
}

let shard: RelayShardState | null = null;
let pendingClaim: Promise<RelayShardState> | null = null;
let starting = false;

async function stopOnLostShard(state: RelayShardState): Promise<void> {
  state.lost = true;
  clearInterval(state.refreshTimer);
  if (state.consumer) clearInterval(state.consumer.sweepTimer);
  // Stop consuming before reporting, so a reporting failure can never leave
  // two consumers on one shard.
  await state.consumer?.worker.close().catch((closeErr: unknown) => {
    console.error(`[AgentCommandRelayWorker] closing the consumer for ${state.queueName} failed:`, closeErr);
  });
  const err = new RelayShardConflictError(
    `relay shard ${state.queueName} was taken by another consumer; this consumer stopped so two consumers never compete for one shard`,
  );
  console.error(`[AgentCommandRelayWorker] ${err.message}`);
  try {
    captureException(err);
    workerReadinessRegistry.recordInitializationFailure(READINESS_NAME, err);
  } catch (reportErr) {
    console.error('[AgentCommandRelayWorker] reporting the lost relay shard failed:', reportErr);
  }
}

function refreshShard(state: RelayShardState): void {
  if (state.lost || state.stopping || state.refreshing) return;
  state.refreshing = (async () => {
    const result = await refreshRelayShard(INSTANCE_ID, state.token);
    if (result === 'reacquired') {
      console.warn(`[AgentCommandRelayWorker] owner key for relay shard ${state.queueName} was absent (Redis was unavailable or the key lapsed); taken`);
    } else if (result === 'lost') {
      await stopOnLostShard(state);
    }
    // 'unavailable' (logged, rate-limited, by refreshRelayShard): keep
    // consuming. The 30 s TTL survives two missed 10 s refreshes. Past that,
    // producers answer `offline` for this shard until a refresh takes it back.
  })()
    .catch((err: unknown) => {
      console.error(`[AgentCommandRelayWorker] owner key refresh for relay shard ${state.queueName} failed:`, err);
    })
    .finally(() => { state.refreshing = null; });
}

function sweepShards(state: RelayShardState): void {
  const consumer = state.consumer;
  if (!consumer || state.lost || state.stopping || consumer.sweeping) return;
  consumer.sweeping = (async () => {
    try {
      const result = await sweepDeadRelayShards(INSTANCE_ID, consumer.suspects, () => state.stopping || state.lost);
      consumer.suspects = result.suspects;
    } catch (err) {
      console.error('[AgentCommandRelayWorker] relay shard sweep failed; retrying next interval:', err);
    }
  })().finally(() => { consumer.sweeping = null; });
}

/** Take the owner key once per process; concurrent callers share one attempt. */
function claimShard(): Promise<RelayShardState> {
  if (shard) return Promise.resolve(shard);
  pendingClaim ??= (async () => {
    const queueName = agentCommandRelayQueueName(INSTANCE_ID);
    const token = randomUUID();
    const result = await acquireRelayShard(INSTANCE_ID, token);
    if (result === 'held') {
      throw new RelayShardConflictError(
        `relay shard ${queueName} is already owned by another consumer; refusing to start a second consumer on it`,
      );
    }
    if (result === 'unavailable') {
      console.warn(`[AgentCommandRelayWorker] could not take the owner key for relay shard ${queueName} (Redis unavailable); the refresh loop takes it once Redis answers`);
    }
    const state: RelayShardState = {
      queueName,
      token,
      lost: false,
      stopping: false,
      refreshTimer: setInterval(() => refreshShard(state), RELAY_SHARD_REFRESH_INTERVAL_MS),
      refreshing: null,
      consumer: null,
    };
    state.refreshTimer.unref?.();
    shard = state;
    return state;
  })().finally(() => { pendingClaim = null; });
  return pendingClaim;
}

async function releaseClaim(state: RelayShardState): Promise<void> {
  state.stopping = true;
  clearInterval(state.refreshTimer);
  if (shard === state) shard = null;
  // A refresh still in flight could take the key back after the release.
  await state.refreshing?.catch(() => {});
  await releaseRelayShard(INSTANCE_ID, state.token).catch((err: unknown) => {
    console.warn(`[AgentCommandRelayWorker] releasing the owner key for ${state.queueName} failed; it expires on its own:`, err);
  });
}

/**
 * Give up a shard claimed before serving when no consumer will start on it
 * (index.ts skips every queue consumer when Redis is unavailable at worker
 * start). Producers then answer `offline` for this instance rather than
 * enqueuing on a queue nobody reads. No-op once a consumer runs.
 */
export async function releaseAgentCommandRelayClaim(): Promise<void> {
  if (pendingClaim) await pendingClaim.catch(() => null);
  if (shard && !shard.consumer && !shard.lost) await releaseClaim(shard);
}

/**
 * Take this instance's relay shard before the API serves (#4134). An agent
 * socket names this instance in its presence lease the moment it connects,
 * and producers answer `offline` for a shard with no owner key, so the key
 * must exist before the first socket does. Never throws: a shard held by
 * another consumer is refused by initializeAgentCommandRelayWorker, which
 * records the readiness failure.
 */
export async function claimAgentCommandRelayShard(): Promise<void> {
  try {
    await claimShard();
  } catch (err) {
    if (!(err instanceof RelayShardConflictError)) {
      console.error('[AgentCommandRelayWorker] claiming the relay shard before serving failed; initialize retries:', err);
    }
  }
}

/**
 * Start this instance's relay consumer (#4134). Takes the shard owner key
 * (unless claimAgentCommandRelayShard already did) and refuses to start if
 * another consumer holds it, then consumes the shard and sweeps the queues of
 * instances that are gone. If Redis cannot answer, it consumes anyway and the
 * refresh loop takes the key later.
 */
export async function initializeAgentCommandRelayWorker(): Promise<void> {
  const queueName = agentCommandRelayQueueName(INSTANCE_ID);
  if (starting || shard?.consumer || shard?.lost) {
    throw new RelayShardConflictError(
      shard?.lost
        ? `relay shard ${queueName} was taken by another consumer; not starting a consumer on it`
        : `a relay consumer for ${queueName} is already running in this process`,
    );
  }
  starting = true;
  let state: RelayShardState | null = null;
  let worker: Worker<RelayJobData> | null = null;
  try {
    state = await claimShard();
    worker = createAgentCommandRelayWorker();
    attachWorkerObservability(worker, READINESS_NAME);
    const owner = state;
    const consumer: RelayConsumer = {
      worker,
      sweepTimer: setInterval(() => sweepShards(owner), RELAY_SHARD_SWEEP_INTERVAL_MS),
      sweeping: null,
      suspects: new Set(),
    };
    consumer.sweepTimer.unref?.();
    state.consumer = consumer;
    sweepShards(state);
    console.log(`[AgentCommandRelayWorker] Initialized on ${queueName}`);
  } catch (error) {
    if (worker) await worker.close().catch(() => {});
    // An owner key with no consumer would have producers enqueue on a queue
    // nobody reads. Without the key they answer `offline` at once.
    if (state && !state.consumer) await releaseClaim(state);
    console.error('[AgentCommandRelayWorker] Failed to initialize:', error);
    throw error;
  } finally {
    starting = false;
  }
}

/**
 * Drain path (#4134). Release the owner key first, so producers answer
 * `offline` for this shard at once instead of enqueuing on a queue about to
 * close. Then stop consuming (in-flight sends finish), ack every job still
 * waiting `owner_mismatch`, and remove the queue. A failed drain is logged,
 * not thrown: another instance's sweep removes the queue later. A failed
 * close is thrown after the drain has run.
 */
export async function shutdownAgentCommandRelayWorker(): Promise<void> {
  if (pendingClaim) await pendingClaim.catch(() => null);
  const state = shard;
  if (!state) return;
  shard = null;
  state.stopping = true;
  clearInterval(state.refreshTimer);
  if (state.consumer) clearInterval(state.consumer.sweepTimer);
  await Promise.allSettled([state.refreshing, state.consumer?.sweeping]);
  // A consumer that lost its shard already stopped, and the shard is not its to drain.
  if (state.lost) return;

  try {
    await releaseRelayShard(INSTANCE_ID, state.token);
  } catch (err) {
    console.warn(`[AgentCommandRelayWorker] releasing the owner key for ${state.queueName} failed; it expires on its own:`, err);
  }
  let closeError: unknown = null;
  if (state.consumer) {
    try {
      await state.consumer.worker.close();
    } catch (err) {
      closeError = err;
      console.error(`[AgentCommandRelayWorker] closing the consumer for ${state.queueName} failed; draining anyway:`, err);
    }
  }
  try {
    const result = await drainRelayQueue(state.queueName);
    if (result.removed) {
      console.log(`[AgentCommandRelayWorker] drained ${state.queueName} on shutdown (${result.acked} waiting job(s) acked owner_mismatch)`);
    }
  } catch (err) {
    console.error(`[AgentCommandRelayWorker] drain of ${state.queueName} on shutdown failed; a live instance's sweep removes it later:`, err);
  }
  if (closeError) throw closeError;
}
