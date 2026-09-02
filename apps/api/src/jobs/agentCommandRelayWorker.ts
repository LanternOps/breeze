import { Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { INSTANCE_ID } from '../services/instanceIdentity';
import { readAgentPresence } from '../services/agentPresence';
import {
  AGENT_COMMAND_RELAY_QUEUE,
  claimRelaySend,
  markRelaySendComplete,
  openRelayCommand,
  writeRelayAck,
  type DispatchOutcome,
  type RelayJobData,
} from '../services/agentCommandRelay';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';

/**
 * Api-role relay consumer (wave 3.5b, #4084).
 *
 * Runs ONLY on a process that may own sockets — registration in index.ts is
 * gated on `breezeRole() !== 'worker'`. Presence merely ADMITTED this job onto
 * the queue; this process's in-memory socket map (agentWs.isAgentConnected)
 * is the actual authority for whether the send can happen at all, and the
 * lease/target-instance checks below re-verify the routing decision wasn't
 * made against a since-superseded lease.
 *
 * The local send path also records `orphanedResultExpectations` HERE — on the
 * process that will receive the eventual `command_result` — which is why this
 * consumer calls `sendCommandToAgent` directly and never re-implements the
 * socket write itself.
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

let relayWorker: Worker<RelayJobData> | null = null;

export function createAgentCommandRelayWorker(): Worker<RelayJobData> {
  return new Worker<RelayJobData>(AGENT_COMMAND_RELAY_QUEUE, processAgentCommandRelayJob, {
    connection: getBullMQConnection(),
    // ws.send is fast; 25 is deliberately conservative — tune from queue-age
    // measurements after 3.5d rolls out, mirroring eventDispatchWorker's note.
    concurrency: 25,
  });
}

export async function initializeAgentCommandRelayWorker(): Promise<void> {
  try {
    relayWorker = createAgentCommandRelayWorker();
    attachWorkerObservability(relayWorker, 'agentCommandRelay');
    console.log('[AgentCommandRelayWorker] Initialized');
  } catch (error) {
    if (relayWorker) {
      await relayWorker.close().catch(() => {});
      relayWorker = null;
    }
    console.error('[AgentCommandRelayWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAgentCommandRelayWorker(): Promise<void> {
  if (relayWorker) {
    await relayWorker.close();
    relayWorker = null;
  }
}
