/**
 * Cross-process agent command relay (wave 3.5b, #4084).
 *
 * A worker process (no local WebSocket) that needs to reach an agent enqueues
 * a job for the API instance that owns the agent's socket; only a process
 * that may own sockets (`BREEZE_ROLE !== 'worker'`) consumes it
 * (agentCommandRelayWorker.ts) and performs the actual local send.
 *
 * Every socket-owning instance has its OWN queue, `agent-command-relay-<id>`,
 * keyed by its per-boot `INSTANCE_ID` (#4134). The producer reads the agent's
 * presence lease and enqueues on the queue of the instance the lease names,
 * so a consumer only ever sees jobs for sockets it can own. With one shared
 * queue, any API consumer could take a job for another instance's socket and
 * could only ack `offline`/`owner_mismatch`. The consumer's fencing check
 * stays as the fallback for a lease that moved after the job was built.
 *
 * This module holds the shared primitives:
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

/**
 * The single shared queue every API consumer drained before #4134. Nothing
 * enqueues on it any more; the consumer's shard reaper removes what an older
 * build left there (see agentCommandRelayShard.ts).
 */
export const LEGACY_AGENT_COMMAND_RELAY_QUEUE = 'agent-command-relay';
const SHARD_QUEUE_PREFIX = `${LEGACY_AGENT_COMMAND_RELAY_QUEUE}-`;
// INSTANCE_ID is a UUID. The bound keeps the name a plain token: BullMQ
// rejects ':' in a queue name, and the shard reaper matches these names with a
// Redis glob, so no glob metacharacter may appear in one either.
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Nobody reads the relay queues' BullMQ event streams (acks travel on their
 * own keys, never QueueEvents). The 10,000-entry default per queue is what
 * filled Redis in a past `maxmemory` incident, so cap it.
 */
export const RELAY_QUEUE_EVENTS_MAX_LEN = 1_000;

/** The relay queue consumed only by the instance `instanceId`. */
export function agentCommandRelayQueueName(instanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(`[agentCommandRelay] instance id ${JSON.stringify(instanceId)} cannot name a relay shard queue`);
  }
  return `${SHARD_QUEUE_PREFIX}${instanceId}`;
}

/**
 * The instance a relay queue name belongs to: its id for a shard, `null` for
 * the legacy shared queue, `undefined` for any other name.
 */
export function relayInstanceIdFromQueueName(name: string): string | null | undefined {
  if (name === LEGACY_AGENT_COMMAND_RELAY_QUEUE) return null;
  if (!name.startsWith(SHARD_QUEUE_PREFIX)) return undefined;
  const instanceId = name.slice(SHARD_QUEUE_PREFIX.length);
  return INSTANCE_ID_PATTERN.test(instanceId) ? instanceId : undefined;
}

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

// Producer handles, one per target instance. They share the BullMQ connection,
// so a handle is cheap. Instance ids change on every API restart, so the map
// is bounded: the oldest handle (a long-gone instance, in practice) is closed.
const MAX_CACHED_RELAY_QUEUES = 32;
const relayQueues = new Map<string, Queue<RelayJobData>>();

/** Producer handle for the shard queue consumed by `instanceId`. */
export function getAgentCommandRelayQueue(instanceId: string): Queue<RelayJobData> {
  const name = agentCommandRelayQueueName(instanceId);
  const cached = relayQueues.get(name);
  if (cached) {
    // Re-insert so the map's iteration order stays least-recently-used first.
    relayQueues.delete(name);
    relayQueues.set(name, cached);
    return cached;
  }
  const queue = createInstrumentedQueue<RelayJobData>(name, {
    streams: { events: { maxLen: RELAY_QUEUE_EVENTS_MAX_LEN } },
  });
  relayQueues.set(name, queue);
  if (relayQueues.size > MAX_CACHED_RELAY_QUEUES) {
    const [oldestName, oldest] = relayQueues.entries().next().value as [string, Queue<RelayJobData>];
    relayQueues.delete(oldestName);
    void oldest.close().catch((err: unknown) => {
      console.warn(`[agentCommandRelay] closing evicted relay queue handle ${oldestName} failed:`, err);
    });
  }
  return queue;
}

export async function shutdownAgentCommandRelayQueue(): Promise<void> {
  const queues = [...relayQueues.values()];
  relayQueues.clear();
  await Promise.all(queues.map((queue) => queue.close()));
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
    // The lease names the socket owner: its own shard is the only queue a
    // consumer that can deliver this command reads.
    await getAgentCommandRelayQueue(lease.instanceId).add('relay-send', data, {
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
