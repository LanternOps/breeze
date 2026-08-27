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
import { getRedis } from './redis';
import { decryptSecret, encryptSecret, getActiveSecretEncryptionKeyId } from './secretCrypto';
import type { AgentCommand } from '../routes/agentWs';

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
