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
import { hasDbAccessContext } from '../db';
import { createInstrumentedQueue } from './bullmqQueue';
import { probeAgentPresence, readAgentPresence } from './agentPresence';
import { captureException } from './sentry';
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
 * The single shared queue every API consumer drained before #4134. Builds
 * from before then still use it while a deploy replaces them. Once none run,
 * nothing enqueues on it, and the shard sweep removes what they left once no
 * consumer is connected to it (see agentCommandRelayShard.ts).
 */
export const LEGACY_AGENT_COMMAND_RELAY_QUEUE = 'agent-command-relay';
const SHARD_QUEUE_PREFIX = `${LEGACY_AGENT_COMMAND_RELAY_QUEUE}-`;
// INSTANCE_ID is a UUID. The bound keeps the name a plain token: BullMQ
// rejects ':' in a queue name, and the shard sweep matches these names with a
// Redis glob, so no glob metacharacter may appear in one either.
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Nobody reads the relay queues' BullMQ event streams (acks travel on their
 * own keys, never QueueEvents). BullMQ's 10,000-entry default per queue is
 * what filled a `noeviction` Redis in a past `maxmemory` incident, so the
 * producer handle caps it. The cap is stored in the queue's meta hash when a
 * handle is built; a queue whose meta is first written by a job add (after an
 * obliterate, say) gets BullMQ's default until the sweep removes it.
 */
export const RELAY_QUEUE_EVENTS_MAX_LEN = 1_000;

/**
 * Shard owner key: held by the one consumer of `agent-command-relay-<id>`.
 * It is the second-consumer guard (agentCommandRelayShard.ts) and the
 * producer's test that a shard has a consumer at all.
 */
export function relayShardOwnerKey(instanceId: string): string {
  return `agent-relay-shard:${instanceId}`;
}

const REDIS_FAILURE_LOG_INTERVAL_MS = 60_000;
const redisFailureLog = new Map<string, { at: number; suppressed: number }>();

/**
 * Warn about a relay Redis call that failed and was answered by a fallback.
 * At most one line per operation per minute, with a count of what was
 * suppressed, so a refresh loop during an outage stays readable.
 */
export function logRelayRedisFailure(operation: string, err: unknown): void {
  warnRateLimited(operation, `${operation} failed`, err);
}

/**
 * Warn about a dispatch that ended without a confirmed answer (#4142): a relay
 * refused inside a held DB context, a transport deadline, an enqueue whose
 * outcome is unknown. Same per-minute limit as {@link logRelayRedisFailure}.
 * The caller only sees the outcome status, so this line is the evidence.
 */
function logRelayDispatchIssue(issue: string, detail: unknown): void {
  warnRateLimited(`dispatch: ${issue}`, issue, detail);
}

function warnRateLimited(key: string, headline: string, detail: unknown): void {
  const now = Date.now();
  const entry = redisFailureLog.get(key);
  if (entry && now - entry.at < REDIS_FAILURE_LOG_INTERVAL_MS) {
    entry.suppressed += 1;
    return;
  }
  const suppressed = entry?.suppressed ?? 0;
  redisFailureLog.set(key, { at: now, suppressed: 0 });
  console.warn(
    `[agentCommandRelay] ${headline}${suppressed > 0 ? ` (${suppressed} more since the last report)` : ''}:`,
    detail instanceof Error ? detail.message : detail,
  );
}

/** TEST ONLY: forget the failure-log rate limit. */
export function __resetRelayRedisFailureLogForTests(): void {
  redisFailureLog.clear();
}

/**
 * Whether a consumer owns the shard `instanceId`. A failed read counts as
 * live: the producer then enqueues as it would have before the check, and a
 * sweep never removes a shard on doubt.
 */
export async function isRelayShardLive(instanceId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    return (await redis.exists(relayShardOwnerKey(instanceId))) === 1;
  } catch (err) {
    logRelayRedisFailure('relay shard liveness read', err);
    return true;
  }
}

/** The relay queue consumed only by the instance `instanceId`. */
export function agentCommandRelayQueueName(instanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(`[agentCommandRelay] instance id ${JSON.stringify(instanceId)} cannot name a relay shard queue`);
  }
  return `${SHARD_QUEUE_PREFIX}${instanceId}`;
}

export type RelayQueueOwner =
  | { kind: 'shard'; instanceId: string }
  | { kind: 'legacy' };

/**
 * Who a relay queue name belongs to: one instance's shard, or the legacy
 * shared queue. `null` for any name that is not a relay queue.
 */
export function relayQueueOwner(name: string): RelayQueueOwner | null {
  if (name === LEGACY_AGENT_COMMAND_RELAY_QUEUE) return { kind: 'legacy' };
  if (!name.startsWith(SHARD_QUEUE_PREFIX)) return null;
  const instanceId = name.slice(SHARD_QUEUE_PREFIX.length);
  return INSTANCE_ID_PATTERN.test(instanceId) ? { kind: 'shard', instanceId } : null;
}

export const RELAY_DELIVERY_DEADLINE_MS = 5_000;
/**
 * One absolute budget for the whole relay path (presence read, shard check,
 * enqueue, ack wait) (#4142). Longer than the job's own 5 s `expiresAt`, so an
 * ack for a job the consumer ran in time still lands inside it. The BullMQ
 * connection retries forever (`maxRetriesPerRequest: null`), so without this
 * bound a Redis outage could hang `queue.add`, and every caller with it.
 */
export const RELAY_TRANSPORT_DEADLINE_MS = 7_000;
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

/**
 * What a dispatch did. `infrastructure_error` means nothing was sent: the
 * failure happened before the enqueue (producer) or before the socket write
 * (relay consumer). A failure after the enqueue was issued, with no consumer
 * answer, is `indeterminate` (#4142).
 */
export type DispatchOutcome =
  | { status: 'sent'; via: 'local' | 'relay' }
  | { status: 'offline' }
  | { status: 'expired' }
  | { status: 'owner_mismatch' }
  | { status: 'indeterminate' }
  | { status: 'infrastructure_error'; message: string };

/**
 * How a caller holding a delivery claim must treat a {@link DispatchOutcome}
 * (#4142):
 *   - `delivered`: the frame reached the socket. Keep the claim.
 *   - `uncertain`: it may have reached the agent. Keep the claim, never retry,
 *     never report the agent unreachable; the result or the reaper settles it.
 *   - `not_delivered`: nothing was sent. Release the claim for the heartbeat.
 */
export type DispatchDisposition = 'delivered' | 'uncertain' | 'not_delivered';

export function dispatchDisposition(outcome: DispatchOutcome): DispatchDisposition {
  switch (outcome.status) {
    case 'sent':
      return 'delivered';
    case 'indeterminate':
      return 'uncertain';
    case 'offline':
    case 'expired':
    case 'owner_mismatch':
    case 'infrastructure_error':
      return 'not_delivered';
    default:
      // Compile-time exhaustiveness; at runtime an ack status this build does
      // not know (a newer consumer's) may have been sent, so keep the claim.
      outcome satisfies never;
      return 'uncertain';
  }
}

const KNOWN_OUTCOME_STATUSES: ReadonlySet<string> = new Set<DispatchOutcome['status']>([
  'sent', 'offline', 'expired', 'owner_mismatch', 'indeterminate', 'infrastructure_error',
]);

/** The message of the outcome a relay refused inside a held DB context. */
export const HELD_DB_CONTEXT_REFUSAL = 'relay refused inside a held DB context (#1105): nothing was enqueued';

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

// Compare-and-delete: a `sent` marker must survive, so a stalled-job
// redelivery still answers already-sent instead of sending twice.
const RELEASE_CLAIM_LUA = `
if redis.call('GET', KEYS[1]) == 'claimed' then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * Give back a send claim taken for a send that did not happen (the job
 * expired before the send, or the local send returned false), so a later relay
 * of the same command can claim it instead of answering `indeterminate` until
 * the claim's TTL lapses (#4142). Never throws: a failed release only leaves
 * the claim to expire on its own.
 */
export async function releaseRelaySendClaim(agentId: string, commandId: string): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.eval(RELEASE_CLAIM_LUA, 1, claimKey(agentId, commandId));
  } catch (err) {
    logRelayRedisFailure('relay send claim release', err);
  }
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
      if (raw) {
        const parsed = JSON.parse(raw) as DispatchOutcome;
        // An ack whose status this build does not know says nothing it can
        // trust about the send: uncertain, never a not-delivered answer.
        return KNOWN_OUTCOME_STATUSES.has(parsed?.status) ? parsed : { status: 'indeterminate' };
      }
    } catch {
      // transient read failure — keep polling until the deadline
    }
    if (Date.now() >= deadline) return { status: 'indeterminate' };
    await new Promise((resolve) => setTimeout(resolve, ACK_POLL_INTERVAL_MS));
  }
}

// Producer handles, one per target instance. They share the BullMQ connection,
// so a handle is cheap. Instance ids change on every API restart, so the map
// is bounded: the least recently used handle (a long-gone instance, in
// practice) is closed. A handle in use is the most recently used, so only more
// than 32 instances in use at once could close one under an in-flight add,
// which would then answer `indeterminate`: the add had been issued, and a
// rejected add cannot prove nothing was stored (#4142).
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

export type AgentReachability = 'connected' | 'absent' | 'unknown';

/**
 * Whether an agent is reachable from this process (#4142). `connected`: a
 * local socket, or a live presence lease naming another instance. `absent`:
 * the lease read answered and there is none. `unknown`: Redis could not
 * answer. Unlike {@link isAgentConnectedAnywhere}, a failed read is never
 * collapsed into absence, so a caller that fast-fails "unreachable" does so
 * only on `absent`.
 */
export async function agentReachability(agentId: string): Promise<AgentReachability> {
  if (breezeRole() !== 'worker' && (await socketLocal()).isAgentConnected(agentId)) return 'connected';
  const probe = await probeAgentPresence(agentId);
  if ('unavailable' in probe) return 'unknown';
  return probe.present ? 'connected' : 'absent';
}

const TRANSPORT_DEADLINE = Symbol('relay transport deadline');

/** `work`, or {@link TRANSPORT_DEADLINE} if it has not settled by `deadlineAt`. */
async function beforeTransportDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<T | typeof TRANSPORT_DEADLINE> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    work.catch(() => {}); // a late rejection must not surface as unhandled
    return TRANSPORT_DEADLINE;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TRANSPORT_DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(TRANSPORT_DEADLINE), remaining);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type DispatchOptions = { priority?: 'probe' | 'normal'; forceRelay?: boolean };

/**
 * Cross-process-safe agent command dispatch (wave 3.5b, #4084).
 *
 * Local-first: on a process that may own sockets, a locally-connected agent
 * gets today's direct send — zero Redis, zero behavior change. Otherwise the
 * presence lease admits (or refuses) a relay enqueue, and the api-role
 * consumer performs the actual socket write. `sent` means the frame reached
 * ws.send() successfully — it says nothing about execution; results flow
 * through device_commands exactly as before.
 *
 * Never rejects (#4142): a throw before the enqueue was issued answers
 * `infrastructure_error` (nothing was sent), a throw after it `indeterminate`.
 * The relay path runs inside one absolute {@link RELAY_TRANSPORT_DEADLINE_MS}
 * budget and refuses to run inside a held DB context. Map the outcome with
 * {@link dispatchDisposition}.
 */
export async function dispatchCommandToAgent(
  agentId: string,
  command: AgentCommand,
  opts: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const progress = { enqueueIssued: false };
  try {
    return await dispatchUnguarded(agentId, command, opts, progress);
  } catch (err) {
    // Not a transport answer: something threw that the steps below do not
    // expect. Reported, then answered by whether the enqueue had been issued.
    captureException(err instanceof Error ? err : new Error(String(err)));
    logRelayDispatchIssue('dispatch threw unexpectedly', err);
    if (progress.enqueueIssued) return { status: 'indeterminate' };
    return { status: 'infrastructure_error', message: `dispatch failed before enqueue: ${errorMessage(err)}` };
  }
}

async function dispatchUnguarded(
  agentId: string,
  command: AgentCommand,
  opts: DispatchOptions,
  progress: { enqueueIssued: boolean },
): Promise<DispatchOutcome> {
  if (!opts.forceRelay && breezeRole() !== 'worker') {
    const local = await socketLocal();
    if (local.isAgentConnected(agentId)) {
      return local.sendCommandToAgent(agentId, command)
        ? { status: 'sent', via: 'local' }
        : { status: 'offline' };
    }
  }

  // The relay waits on Redis for up to the transport deadline. Inside a held
  // DB context that wait would pin a pooled connection idle-in-transaction
  // (#1105), so the relay refuses: nothing is enqueued, nothing waits, and the
  // caller releases its claim for the heartbeat. Work that must reach another
  // instance runs after the context: runAfterDbContextCommit, or
  // runOutsideDbContext for a send that deliberately does not wait on commit.
  if (hasDbAccessContext()) {
    logRelayDispatchIssue(
      'relay refused inside a held DB context; the command waits for the agent\'s heartbeat',
      `command type ${command.type}`,
    );
    return { status: 'infrastructure_error', message: HELD_DB_CONTEXT_REFUSAL };
  }

  const deadlineAt = Date.now() + RELAY_TRANSPORT_DEADLINE_MS;
  const lease = await beforeTransportDeadline(readAgentPresence(agentId), deadlineAt);
  if (lease === TRANSPORT_DEADLINE) {
    const message = 'relay transport deadline passed before enqueue (presence read)';
    logRelayDispatchIssue(message, `command type ${command.type}`);
    return { status: 'infrastructure_error', message };
  }
  if (!lease) return { status: 'offline' };

  try {
    agentCommandRelayQueueName(lease.instanceId);
  } catch (err) {
    return {
      status: 'infrastructure_error',
      message: `relay enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // A lease can outlive its instance by up to its TTL: a crash, or a shutdown
  // whose lease clears did not land. No consumer reads that instance's shard,
  // so answer now rather than park a job nobody takes and time out. The shared
  // queue answered the same case at once, through another instance's consumer.
  const shardLive = await beforeTransportDeadline(isRelayShardLive(lease.instanceId), deadlineAt);
  if (shardLive === TRANSPORT_DEADLINE) {
    const message = 'relay transport deadline passed before enqueue (shard check)';
    logRelayDispatchIssue(message, `command type ${command.type}`);
    return { status: 'infrastructure_error', message };
  }
  if (!shardLive) return { status: 'offline' };

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
  let added: Promise<unknown>;
  try {
    // The lease names the socket owner: its own shard is the only queue a
    // consumer that can deliver this command reads.
    added = getAgentCommandRelayQueue(lease.instanceId).add('relay-send', data, {
      jobId: `relay-${relayId}`,
      attempts: 1, // at-most-once: claims (not BullMQ retries) guard the send
      priority: opts.priority === 'probe' ? 1 : 10,
      removeOnComplete: true,
      removeOnFail: 100,
    });
  } catch (err) {
    // A synchronous throw: the add was never issued, so nothing was sent.
    return { status: 'infrastructure_error', message: `relay enqueue failed: ${errorMessage(err)}` };
  }
  progress.enqueueIssued = true;

  // From here the job may exist even when the add reports failure (Redis can
  // store it before the reply is lost), so every failure is `indeterminate`.
  let enqueued: unknown;
  try {
    enqueued = await beforeTransportDeadline(added, deadlineAt);
  } catch (err) {
    logRelayDispatchIssue('relay enqueue rejected after it was issued; outcome indeterminate', err);
    return { status: 'indeterminate' };
  }
  if (enqueued === TRANSPORT_DEADLINE) {
    logRelayDispatchIssue(
      'relay enqueue did not settle within the transport deadline; outcome indeterminate',
      `command type ${command.type}`,
    );
    return { status: 'indeterminate' };
  }

  const ack = await beforeTransportDeadline(
    awaitRelayAck(relayId, Math.max(0, deadlineAt - Date.now())),
    deadlineAt,
  );
  const outcome: DispatchOutcome = ack === TRANSPORT_DEADLINE ? { status: 'indeterminate' } : ack;
  if (outcome.status === 'indeterminate') {
    // No ack in time, an ack this build cannot read, or a consumer that found
    // the send claim held by another delivery.
    logRelayDispatchIssue('relay delivery unconfirmed; outcome indeterminate', `command type ${command.type}`);
  }
  return outcome;
}
