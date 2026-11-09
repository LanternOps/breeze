/**
 * Cross-process agent socket eviction: the `relay-evict` operation (#4142 W2).
 *
 * Closing an agent's WebSocket used to be socket-local (`disconnectAgent` in
 * routes/agentWs.ts): a tenant sever or a Quick Support end reached only the
 * sockets of the process that ran it, and a worker-role process reached none.
 * This module closes them wherever they live:
 *
 *   1. Local first. A process that may own sockets closes its own at once,
 *      with no Redis round trip.
 *   2. Everything else is routed by presence lease to the owning instance's
 *      relay shard (the same per-instance queue command sends use, #4134), as
 *      list-shaped jobs of at most {@link RELAY_EVICT_MAX_ENTRIES} entries.
 *   3. The owner closes a socket only when its live connection record still
 *      carries the lease's `connectionToken` (`disconnectAgentConnection`), so
 *      an eviction never closes a newer connection that replaced the one the
 *      producer saw.
 *
 * Every entry gets its own typed {@link EvictOutcome}; callers audit it.
 * Nothing secret travels, so the job is not sealed. The job deliberately has
 * no top-level `agentId` / `commandId` / `sealedCommand`: a consumer from
 * before this operation existed reads it as a send job, finds no socket for an
 * undefined agent, closes nothing and acks `offline`. An awaiting producer
 * maps that to `indeterminate` for every entry; a queued eviction
 * (`awaitAck: false`) never reads the ack, so on such an instance it is
 * reported `queued` and simply does not happen (rolling deploys; see
 * docs/deploy/worker-split.md).
 *
 * Call it after the transaction that made the change commits
 * (`runAfterDbContextCommit`), or outside any DB context: like the command
 * relay, it refuses to wait on Redis inside a held context (#1105).
 */
import { randomUUID } from 'crypto';
import { hasDbAccessContext } from '../db';
import { captureException } from './sentry';
import { readAgentPresenceBatch, type AgentPresenceLease } from './agentPresence';
import {
  agentCommandRelayQueueName,
  beforeTransportDeadline,
  closeLocalAgentSockets,
  getAgentCommandRelayQueue,
  isRelayShardLive,
  logRelayDispatchIssue,
  pollRelayAck,
  RELAY_DELIVERY_DEADLINE_MS,
  RELAY_TRANSPORT_DEADLINE_MS,
  TRANSPORT_DEADLINE,
  writeRelayAckPayload,
} from './agentCommandRelay';

/**
 * Close codes an eviction may use: 4001 credential/tenant cutoff, 4040 org
 * change, 4041 the device is gone (decommission, Quick Support end). The
 * consumer refuses any other, so a tampered job cannot pick a code the agent
 * treats differently.
 */
export type AgentEvictCloseCode = 4001 | 4040 | 4041;
const AGENT_EVICT_CLOSE_CODES: ReadonlySet<number> = new Set<AgentEvictCloseCode>([4001, 4040, 4041]);

/** Entries per `relay-evict` job; a larger request is split. */
export const RELAY_EVICT_MAX_ENTRIES = 500;
/** WebSocket close reasons are capped at 123 bytes; ours stay ASCII and short. */
export const RELAY_EVICT_REASON_MAX_LENGTH = 120;
export const RELAY_EVICT_JOB_NAME = 'relay-evict';
/**
 * Expiry of an eviction nobody waits on (`awaitAck: false`). Longer than the
 * awaited path's {@link RELAY_DELIVERY_DEADLINE_MS}: the fence makes a late
 * close safe (it only ever closes the connection the lease named), and with no
 * caller left to act on an answer, a 5 s expiry would only turn a briefly
 * backed-up shard into a silently dropped sever.
 */
export const RELAY_EVICT_QUEUED_TTL_MS = 60_000;

export interface EvictRequest {
  agentId: string;
  code: AgentEvictCloseCode;
  /** At most {@link RELAY_EVICT_REASON_MAX_LENGTH} characters. */
  reason: string;
}

export type EvictOutcome =
  /**
   * `close()` succeeded on the live socket (not "the agent is offline
   * everywhere"). Via `relay` it is fenced to the lease's connection; the
   * local path closes whatever this process holds for the agent (at most one).
   */
  | { status: 'closed'; via: 'local' | 'relay' }
  /** `close()` threw: the channel plausibly stayed live. */
  | { status: 'close_failed'; via: 'local' | 'relay' }
  /** The lease read answered and there is none, or the owner holds no socket. */
  | { status: 'not_connected' }
  /** The lease moved, the job reached another instance, or the owner's socket is a newer connection. */
  | { status: 'owner_mismatch' }
  | { status: 'expired' }
  /** `awaitAck: false` and the enqueue was accepted. */
  | { status: 'queued' }
  /** The enqueue or the ack is uncertain, or a consumer that predates relay-evict answered. */
  | { status: 'indeterminate' }
  /** Nothing was attempted for this entry: see `reason`. */
  | { status: 'unavailable'; reason: EvictUnavailableReason };

export type EvictUnavailableReason =
  | 'invalid_request'
  | 'held_db_context'
  | 'presence_unavailable'
  | 'transport_deadline'
  | 'invalid_instance'
  | 'shard_dead'
  | 'enqueue_failed'
  | 'unexpected_error';

export interface RelayEvictJobEntry {
  agentId: string;
  connectionToken: string;
  code: AgentEvictCloseCode;
  reason: string;
}

export interface RelayEvictJobData {
  relayId: string;
  targetInstanceId: string;
  expiresAt: number;
  /** False when the producer does not wait: the consumer then writes no ack. */
  awaitAck: boolean;
  entries: RelayEvictJobEntry[];
}

/** The ack body of a `relay-evict` job: one outcome per entry, keyed by agent id. */
export interface RelayEvictAck {
  kind: 'evict';
  outcomes: Record<string, EvictOutcome>;
}

/** A request (producer) or job entry (consumer) the eviction may act on. */
export function isValidEvictRequest<T extends { agentId?: unknown; code?: unknown; reason?: unknown }>(
  r: T,
): r is T & EvictRequest {
  return typeof r.agentId === 'string' && r.agentId.length > 0
    && typeof r.code === 'number' && AGENT_EVICT_CLOSE_CODES.has(r.code)
    && typeof r.reason === 'string' && r.reason.length <= RELAY_EVICT_REASON_MAX_LENGTH;
}

/**
 * The job-level shape of a `relay-evict` payload read back from Redis, or
 * null when it is not one this build can act on. Entries are only checked to
 * be a bounded list here: the consumer validates each entry on its own, so
 * one bad entry never voids the rest.
 */
export function parseRelayEvictJob(raw: unknown): RelayEvictJobData | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<RelayEvictJobData>;
  if (typeof d.relayId !== 'string' || d.relayId.length === 0) return null;
  if (typeof d.targetInstanceId !== 'string') return null;
  if (typeof d.expiresAt !== 'number' || !Number.isFinite(d.expiresAt)) return null;
  if (typeof d.awaitAck !== 'boolean') return null;
  if (!Array.isArray(d.entries) || d.entries.length > RELAY_EVICT_MAX_ENTRIES) return null;
  return d as RelayEvictJobData;
}

export async function writeRelayEvictAck(relayId: string, outcomes: Record<string, EvictOutcome>): Promise<void> {
  const ack: RelayEvictAck = { kind: 'evict', outcomes };
  await writeRelayAckPayload(relayId, ack);
}

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<EvictUnavailableReason>([
  'invalid_request', 'held_db_context', 'presence_unavailable', 'transport_deadline',
  'invalid_instance', 'shard_dead', 'enqueue_failed', 'unexpected_error',
]);

/** One entry of a consumer's ack, or null when this build cannot trust it. */
function readAckedOutcome(value: unknown): EvictOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as { status?: unknown; via?: unknown; reason?: unknown };
  switch (o.status) {
    case 'closed':
    case 'close_failed':
      return o.via === 'local' || o.via === 'relay' ? { status: o.status, via: o.via } : null;
    case 'not_connected':
    case 'owner_mismatch':
    case 'expired':
      return { status: o.status };
    case 'unavailable':
      return typeof o.reason === 'string' && UNAVAILABLE_REASONS.has(o.reason)
        ? { status: 'unavailable', reason: o.reason as EvictUnavailableReason }
        : null;
    default:
      return null;
  }
}

/**
 * Map an ack body to an outcome per agent. Anything this build cannot read
 * (no ack, a scalar ack from a consumer that predates relay-evict, a missing
 * or malformed entry) is `indeterminate`: the close may or may not have run.
 */
function outcomesFromAck(raw: unknown, agentIds: readonly string[]): Map<string, EvictOutcome> {
  const ack = raw as Partial<RelayEvictAck> | undefined;
  const outcomes = ack?.kind === 'evict' && ack.outcomes && typeof ack.outcomes === 'object' ? ack.outcomes : null;
  return new Map(agentIds.map((agentId) => {
    const entry = outcomes && Object.prototype.hasOwnProperty.call(outcomes, agentId) ? outcomes[agentId] : undefined;
    return [agentId, readAckedOutcome(entry) ?? { status: 'indeterminate' }];
  }));
}

type RemoteEntry = RelayEvictJobEntry;

/**
 * Close the live agent sockets named by `requests`, on whichever instance owns
 * each one. Never rejects. Answers one outcome per distinct agent id (the
 * first request for an id wins), in request order.
 *
 * `awaitAck` (default true) waits for the owners' per-entry answers within one
 * absolute {@link RELAY_TRANSPORT_DEADLINE_MS} budget. `false` answers
 * `queued` once each job is enqueued, for fleet-wide work no caller audits
 * entry by entry (a tenant sever).
 */
export async function evictAgentSockets(
  requests: readonly EvictRequest[],
  opts: { awaitAck?: boolean } = {},
): Promise<Map<string, EvictOutcome>> {
  const outcomes = new Map<string, EvictOutcome | null>();
  const unique: EvictRequest[] = [];
  for (const request of requests) {
    if (outcomes.has(request.agentId)) continue;
    outcomes.set(request.agentId, null);
    unique.push(request);
  }
  // Entries whose job add was issued: an unexpected throw after that point
  // cannot prove nothing reached the owner.
  const issued = new Set<string>();
  try {
    await evictUnguarded(unique, opts.awaitAck ?? true, outcomes, issued);
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    logRelayDispatchIssue('eviction threw unexpectedly', err);
  }
  const answered = new Map<string, EvictOutcome>();
  for (const [agentId, outcome] of outcomes) {
    answered.set(agentId, outcome ?? (issued.has(agentId)
      ? { status: 'indeterminate' }
      : { status: 'unavailable', reason: 'unexpected_error' }));
  }
  return answered;
}

async function evictUnguarded(
  requests: readonly EvictRequest[],
  awaitAck: boolean,
  outcomes: Map<string, EvictOutcome | null>,
  issued: Set<string>,
): Promise<void> {
  const valid: EvictRequest[] = [];
  for (const request of requests) {
    const { agentId } = request;
    if (isValidEvictRequest(request)) valid.push(request);
    else outcomes.set(agentId, { status: 'unavailable', reason: 'invalid_request' });
  }
  if (valid.length === 0) return;

  // 1. Local first: no Redis, no wait. Null on the worker role.
  const local = await closeLocalAgentSockets(valid);
  const remote: EvictRequest[] = [];
  for (const request of valid) {
    const result = local?.get(request.agentId);
    if (result === 'closed') outcomes.set(request.agentId, { status: 'closed', via: 'local' });
    else if (result === 'close-failed') outcomes.set(request.agentId, { status: 'close_failed', via: 'local' });
    else remote.push(request);
  }
  if (remote.length === 0) return;

  // 2. The relay waits on Redis; inside a held DB context that would pin a
  // pooled connection idle-in-transaction (#1105). Refuse: nothing is read or
  // enqueued. Callers evict post-commit.
  const answerRemote = (outcome: EvictOutcome) => {
    for (const request of remote) outcomes.set(request.agentId, outcome);
  };
  if (hasDbAccessContext()) {
    logRelayDispatchIssue('eviction refused inside a held DB context', `${remote.length} remote agent(s)`);
    answerRemote({ status: 'unavailable', reason: 'held_db_context' });
    return;
  }

  const deadlineAt = Date.now() + RELAY_TRANSPORT_DEADLINE_MS;
  let leases: Map<string, AgentPresenceLease | null> | typeof TRANSPORT_DEADLINE;
  try {
    leases = await beforeTransportDeadline(readAgentPresenceBatch(remote.map((r) => r.agentId)), deadlineAt);
  } catch (err) {
    logRelayDispatchIssue('eviction presence read failed', err);
    answerRemote({ status: 'unavailable', reason: 'presence_unavailable' });
    return;
  }
  if (leases === TRANSPORT_DEADLINE) {
    logRelayDispatchIssue('eviction presence read passed the transport deadline', `${remote.length} agent(s)`);
    answerRemote({ status: 'unavailable', reason: 'transport_deadline' });
    return;
  }

  // 3. Group by the instance each lease names.
  const byInstance = new Map<string, RemoteEntry[]>();
  for (const request of remote) {
    const lease = leases.get(request.agentId);
    if (!lease) {
      outcomes.set(request.agentId, { status: 'not_connected' });
      continue;
    }
    const group = byInstance.get(lease.instanceId) ?? [];
    group.push({
      agentId: request.agentId, connectionToken: lease.connectionToken, code: request.code, reason: request.reason,
    });
    byInstance.set(lease.instanceId, group);
  }

  await Promise.all([...byInstance].map(([instanceId, entries]) =>
    evictOnInstance(instanceId, entries, awaitAck, deadlineAt, outcomes, issued)));
}

async function evictOnInstance(
  instanceId: string,
  entries: RemoteEntry[],
  awaitAck: boolean,
  deadlineAt: number,
  outcomes: Map<string, EvictOutcome | null>,
  issued: Set<string>,
): Promise<void> {
  const answer = (outcome: EvictOutcome) => {
    for (const entry of entries) outcomes.set(entry.agentId, outcome);
  };
  try {
    agentCommandRelayQueueName(instanceId);
  } catch (err) {
    logRelayDispatchIssue('eviction lease names an instance that cannot name a relay shard', err);
    answer({ status: 'unavailable', reason: 'invalid_instance' });
    return;
  }
  // A shard with no owner key has no consumer. Unlike a command send, that is
  // not proof the socket is gone (the owner may have lost Redis while still
  // serving), so the answer is `unavailable`, never `not_connected`.
  const live = await beforeTransportDeadline(isRelayShardLive(instanceId), deadlineAt);
  if (live === TRANSPORT_DEADLINE) {
    answer({ status: 'unavailable', reason: 'transport_deadline' });
    return;
  }
  if (!live) {
    logRelayDispatchIssue('eviction target shard has no consumer', `instance ${instanceId}`);
    answer({ status: 'unavailable', reason: 'shard_dead' });
    return;
  }

  const jobs: RemoteEntry[][] = [];
  for (let i = 0; i < entries.length; i += RELAY_EVICT_MAX_ENTRIES) {
    jobs.push(entries.slice(i, i + RELAY_EVICT_MAX_ENTRIES));
  }
  await Promise.all(jobs.map((jobEntries) =>
    enqueueEvictJob(instanceId, jobEntries, awaitAck, deadlineAt, outcomes, issued)));
}

async function enqueueEvictJob(
  instanceId: string,
  entries: RemoteEntry[],
  awaitAck: boolean,
  deadlineAt: number,
  outcomes: Map<string, EvictOutcome | null>,
  issued: Set<string>,
): Promise<void> {
  const answer = (outcome: EvictOutcome) => {
    for (const entry of entries) outcomes.set(entry.agentId, outcome);
  };
  const relayId = randomUUID();
  const data: RelayEvictJobData = {
    relayId,
    targetInstanceId: instanceId,
    expiresAt: Date.now() + (awaitAck ? RELAY_DELIVERY_DEADLINE_MS : RELAY_EVICT_QUEUED_TTL_MS),
    awaitAck,
    entries,
  };
  let added: Promise<unknown>;
  try {
    added = getAgentCommandRelayQueue(instanceId).add(RELAY_EVICT_JOB_NAME, data, {
      jobId: `relay-${relayId}`,
      attempts: 1, // a redelivered eviction is harmless (fenced), but there is no reason to retry one
      priority: 5, // ahead of routine sends (10), behind probes (1)
      removeOnComplete: true,
      removeOnFail: 100,
    });
  } catch (err) {
    // A synchronous throw: the add was never issued, nothing reached the owner.
    logRelayDispatchIssue('eviction enqueue failed', err);
    answer({ status: 'unavailable', reason: 'enqueue_failed' });
    return;
  }
  for (const entry of entries) issued.add(entry.agentId);

  // From here the job may exist even when the add reports failure.
  let enqueued: unknown;
  try {
    enqueued = await beforeTransportDeadline(added, deadlineAt);
  } catch (err) {
    logRelayDispatchIssue('eviction enqueue rejected after it was issued; outcome indeterminate', err);
    answer({ status: 'indeterminate' });
    return;
  }
  if (enqueued === TRANSPORT_DEADLINE) {
    logRelayDispatchIssue('eviction enqueue did not settle within the transport deadline', `instance ${instanceId}`);
    answer({ status: 'indeterminate' });
    return;
  }
  if (!awaitAck) {
    answer({ status: 'queued' });
    return;
  }

  const raw = await beforeTransportDeadline(pollRelayAck(relayId, Math.max(0, deadlineAt - Date.now())), deadlineAt);
  const ack = raw === TRANSPORT_DEADLINE ? undefined : raw;
  // The evidence for an `indeterminate` the caller only sees as a status: no
  // consumer answered in time (dead consumer, backlog, Redis), or the answer
  // is not an evict ack (a consumer from before relay-evict, mid-deploy).
  if (ack === undefined) {
    logRelayDispatchIssue('eviction ack did not arrive within the transport deadline', `instance ${instanceId}, ${entries.length} agent(s)`);
  } else if ((ack as Partial<RelayEvictAck> | null)?.kind !== 'evict') {
    logRelayDispatchIssue('eviction ack is not an evict ack (consumer predates relay-evict?)', `instance ${instanceId}, ${entries.length} agent(s)`);
  }
  const mapped = outcomesFromAck(ack, entries.map((e) => e.agentId));
  for (const [agentId, outcome] of mapped) outcomes.set(agentId, outcome);
}
