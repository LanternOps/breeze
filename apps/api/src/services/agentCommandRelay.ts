/**
 * Cross-process agent command relay (wave 3.5b, #4084).
 *
 * A worker process (no local WebSocket) that needs to reach an agent enqueues
 * a job on `agent-command-relay`; only a process that may own sockets
 * (`BREEZE_ROLE !== 'worker'`) consumes it (agentCommandRelayWorker.ts) and
 * performs the actual local send. This module holds the shared primitives:
 *
 *   - a sealed, AAD-bound envelope for the relay job payload (SNMP/discovery/
 *     backup commands carry DECRYPTED credentials — the job persists in Redis,
 *     AOF/snapshots, and failed-job tooling, so it must never carry plaintext)
 *   - an at-most-once send claim (Redis CAS) so a BullMQ stalled-job
 *     redelivery can never double-send
 *   - a typed ack channel the producer polls (never BRPOP/QueueEvents/
 *     waitUntilFinished — blocking commands on the shared connection stall
 *     every enqueue, #3299; no repo precedent for QueueEvents)
 */
import { randomUUID } from 'crypto';
import type { Queue } from 'bullmq';
import { getRedis } from './redis';
import { decryptSecret, encryptSecret, getActiveSecretEncryptionKeyId } from './secretCrypto';
import { breezeRole } from '../config/env';
import { createInstrumentedQueue } from './bullmqQueue';
import { readAgentPresence } from './agentPresence';
import type { AgentCommand } from '../routes/agentWs';

// Socket-local dispatch, loaded LAZILY (#4141). The static value-import of
// routes/agentWs.ts was the single edge pinning every facade caller
// (monitor/snmp/backup/discovery/networkBaseline workers) to socket-owner
// placement in the worker registry's mechanical closure classification —
// runtime was already safe (both call sites sit behind breezeRole() !==
// 'worker' guards, so a worker-role process never touches the socket map).
// The dynamic import is module-cached by Node after the first call; the
// extra await on the local-first hot path is a cache hit thereafter.
async function socketLocal(): Promise<{
  isAgentConnected: (agentId: string) => boolean;
  sendCommandToAgent: (agentId: string, command: AgentCommand) => boolean;
}> {
  return import('../routes/agentWs');
}

export const AGENT_COMMAND_RELAY_QUEUE = 'agent-command-relay';
export const RELAY_DELIVERY_DEADLINE_MS = 5_000;
const ACK_POLL_INTERVAL_MS = 100;
const ACK_TTL_MS = 30_000;
const CLAIM_TTL_MS = 60_000;
const SENT_MARKER_TTL_MS = 600_000; // outlives any BullMQ stalled-job redelivery window

// AAD-bound ciphertext (secretCrypto v3) prefix. encryptSecret silently drops
// to the un-bound v1 fallback and IGNORES aad entirely when no
// APP_ENCRYPTION_KEY_ID is configured (see scriptSecretEnvelope.ts's identical
// guard) — that degradation is unacceptable here, where AAD binding IS the
// tamper defense the design authority requires.
const AAD_BOUND_PREFIX = 'enc:v3:';

export type DispatchOutcome =
  | { status: 'sent'; via: 'local' | 'relay' }
  | { status: 'offline' }
  | { status: 'expired' }
  | { status: 'owner_mismatch' }
  | { status: 'indeterminate' }
  | { status: 'infrastructure_error'; message: string };

export interface RelayEnvelopeBinding {
  agentId: string;
  commandId: string;
  targetInstanceId: string;
  expiresAt: number;
}

export interface RelayJobData {
  relayId: string;
  agentId: string;
  commandId: string;
  targetInstanceId: string;
  connectionToken: string;
  expiresAt: number;
  sealedCommand: string;
}

// The BullMQ payload persists in Redis (and its AOF/snapshots, failed-job
// tooling) — SNMP/discovery/backup commands carry DECRYPTED credentials, so
// the whole command is sealed and the AAD binds the routing metadata: any
// tamper of agentId/commandId/target/expiry makes decryption fail closed.
function relayAad(b: RelayEnvelopeBinding): string {
  return `agent_command_relay:${b.agentId}:${b.commandId}:${b.targetInstanceId}:${b.expiresAt}`;
}

export function sealRelayCommand(command: AgentCommand, binding: RelayEnvelopeBinding): string {
  // A live command must never ride the v1 fallback — AAD binding is the
  // entire tamper defense for this envelope.
  if (!getActiveSecretEncryptionKeyId()) {
    throw new Error(
      '[agentCommandRelay] APP_ENCRYPTION_KEY_ID is not configured; AAD-bound (v3) encryption is required to seal a relay command',
    );
  }
  const sealed = encryptSecret(JSON.stringify(command), { aad: relayAad(binding) });
  if (!sealed || !sealed.startsWith(AAD_BOUND_PREFIX)) {
    throw new Error('[agentCommandRelay] encryption did not produce an AAD-bound envelope');
  }
  return sealed;
}

export function openRelayCommand(sealed: string, binding: RelayEnvelopeBinding): AgentCommand {
  if (typeof sealed !== 'string' || !sealed.startsWith(AAD_BOUND_PREFIX)) {
    throw new Error('[agentCommandRelay] sealed command is not AAD-bound ciphertext');
  }
  const plain = decryptSecret(sealed, { aad: relayAad(binding) });
  if (!plain) {
    throw new Error('[agentCommandRelay] sealed command decrypted to empty');
  }
  return JSON.parse(plain) as AgentCommand;
}

const CLAIM_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing == 'sent' then return 2 end
if existing then return 0 end
redis.call('SET', KEYS[1], 'claimed', 'PX', ARGV[1])
return 1
`;

function claimKey(agentId: string, commandId: string): string {
  return `agent-relay-claim:${agentId}:${commandId}`;
}

export async function claimRelaySend(
  agentId: string, commandId: string,
): Promise<'claimed' | 'already-sent' | 'in-flight'> {
  const redis = getRedis();
  if (!redis) throw new Error('[AgentRelay] Redis unavailable — cannot take send claim');
  const res = await redis.eval(CLAIM_LUA, 1, claimKey(agentId, commandId), String(CLAIM_TTL_MS));
  if (res === 2) return 'already-sent';
  if (res === 1) return 'claimed';
  return 'in-flight';
}

export async function markRelaySendComplete(agentId: string, commandId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(claimKey(agentId, commandId), 'sent', 'PX', SENT_MARKER_TTL_MS);
}

function ackKey(relayId: string): string {
  return `agent-relay-ack:${relayId}`;
}

export async function writeRelayAck(relayId: string, outcome: DispatchOutcome): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(ackKey(relayId), JSON.stringify(outcome), 'PX', ACK_TTL_MS);
}

// Plain GET polling on the shared connection — deliberately NOT BRPOP /
// QueueEvents / waitUntilFinished (blocking commands on the shared connection
// stall every enqueue, #3299; QueueEvents has no repo precedent).
export async function awaitRelayAck(relayId: string, deadlineMs: number): Promise<DispatchOutcome> {
  const redis = getRedis();
  if (!redis) return { status: 'indeterminate' };
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const raw = await redis.get(ackKey(relayId));
      if (raw) return JSON.parse(raw) as DispatchOutcome;
    } catch {
      // transient read failure — keep polling until the deadline
    }
    if (Date.now() >= deadline) return { status: 'indeterminate' };
    await new Promise((resolve) => setTimeout(resolve, ACK_POLL_INTERVAL_MS));
  }
}

let relayQueue: Queue<RelayJobData> | null = null;

export function getAgentCommandRelayQueue(): Queue<RelayJobData> {
  if (!relayQueue) {
    relayQueue = createInstrumentedQueue<RelayJobData>(AGENT_COMMAND_RELAY_QUEUE);
  }
  return relayQueue;
}

export async function shutdownAgentCommandRelayQueue(): Promise<void> {
  if (relayQueue) {
    await relayQueue.close();
    relayQueue = null;
  }
}

export async function isAgentConnectedAnywhere(agentId: string): Promise<boolean> {
  if (breezeRole() !== 'worker' && (await socketLocal()).isAgentConnected(agentId)) return true;
  return (await readAgentPresence(agentId)) !== null;
}

/**
 * Cross-process-safe agent command dispatch (wave 3.5b, #4084).
 *
 * Local-first: on a process that may own sockets, a locally-connected agent
 * gets today's direct send — zero Redis, zero behavior change. Otherwise the
 * presence lease admits (or refuses) a relay enqueue, and the api-role
 * consumer performs the actual socket write. `sent` means the frame reached
 * ws.send() successfully — it says nothing about execution; results flow
 * through device_commands exactly as before.
 */
export async function dispatchCommandToAgent(
  agentId: string,
  command: AgentCommand,
  opts: { priority?: 'probe' | 'normal'; forceRelay?: boolean } = {},
): Promise<DispatchOutcome> {
  if (!opts.forceRelay && breezeRole() !== 'worker') {
    const local = await socketLocal();
    if (local.isAgentConnected(agentId)) {
      return local.sendCommandToAgent(agentId, command)
        ? { status: 'sent', via: 'local' }
        : { status: 'offline' };
    }
  }

  const lease = await readAgentPresence(agentId);
  if (!lease) return { status: 'offline' };

  const relayId = randomUUID();
  const expiresAt = Date.now() + RELAY_DELIVERY_DEADLINE_MS;
  const binding: RelayEnvelopeBinding = {
    agentId, commandId: command.id, targetInstanceId: lease.instanceId, expiresAt,
  };
  let sealedCommand: string;
  try {
    sealedCommand = sealRelayCommand(command, binding);
  } catch (err) {
    return {
      status: 'infrastructure_error',
      message: `relay envelope seal failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const data: RelayJobData = {
    relayId, agentId, commandId: command.id,
    targetInstanceId: lease.instanceId, connectionToken: lease.connectionToken,
    expiresAt, sealedCommand,
  };
  try {
    await getAgentCommandRelayQueue().add('relay-send', data, {
      jobId: `relay-${relayId}`,
      attempts: 1, // at-most-once: claims (not BullMQ retries) guard the send
      priority: opts.priority === 'probe' ? 1 : 10,
      removeOnComplete: true,
      removeOnFail: 100,
    });
  } catch (err) {
    return {
      status: 'infrastructure_error',
      message: `relay enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return awaitRelayAck(relayId, RELAY_DELIVERY_DEADLINE_MS);
}
