/**
 * #4135 — dispatch records that authorize "orphaned" command results.
 *
 * Some commands are sent straight down the agent socket with no deviceCommands
 * row behind them: SNMP polls, network monitor checks and manual reachability
 * probes. When their `command_result` comes back, the only proof that this
 * agent was asked for a result about that target is the record written when
 * the command was sent. `processOrphanedCommandResult` (routes/agentWs.ts)
 * refuses a result without one.
 *
 * The record used to live in a Map on the process that sent the command. With
 * more than one API replica the result can arrive somewhere else: the agent
 * drops its socket and reconnects to a different replica before replying. So
 * the record lives in Redis, keyed by agent and command id, with the same
 * 30-minute TTL the Map pruned on. Any replica can read it, and GETDEL keeps it
 * single-use across all of them.
 *
 * Redis is the only store while it is reachable; no replica keeps a local copy.
 * The in-process Map is a fallback for when Redis is not: no client, a client
 * that is connecting, reconnecting or closed, or a write that fails or times
 * out. That keeps a single-replica deployment working as it did before. A
 * record held locally can only be honored by this process.
 *
 * Every degraded outcome is logged through one rate-limited logger (at most
 * one line per DEGRADED_LOG_INTERVAL_MS): a record held locally, a read
 * skipped because Redis is unusable, a read that failed or timed out. A read
 * that cannot reach Redis treats the result as unexpected (fail-closed).
 *
 * A consume takes the local copy and, when Redis is usable, also GETDELs the
 * Redis key. A write that timed out may still land in Redis after its local
 * copy was taken, and consuming from both is what keeps that record
 * single-use. A peek returns the local copy when there is one and otherwise
 * reads Redis.
 */
import { getRedis } from './redis';

export const ORPHANED_RESULT_EXPECTATION_TTL_MS = 30 * 60 * 1000;

/**
 * Upper bound on a single Redis call, read or write. The reads run inside the
 * short org-scoped transaction that handles an orphaned result, so each one
 * holds a pooled DB connection while it waits; a peek followed by a consume can
 * wait up to twice this.
 */
export const ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS = 500;

/** At most one degraded-mode log line per interval, so an outage cannot flood the log. */
export const DEGRADED_LOG_INTERVAL_MS = 60_000;

/** Expired local records are swept at most this often; reads check expiry themselves. */
const LOCAL_PRUNE_INTERVAL_MS = 60_000;

const KEY_PREFIX = 'agent-orphaned-result:';

export type OrphanedResultExpectation =
  | { agentId: string; kind: 'snmp'; targetId: string; expiresAt: number }
  | { agentId: string; kind: 'monitor'; targetId: string; expiresAt: number }
  // Spec §5 — a manual probe. The expected ip/site are captured at DISPATCH so
  // the result handler can refuse a result for an asset that has since moved or
  // been re-addressed; they are not derivable from the agent's reply.
  | { agentId: string; kind: 'probe'; targetId: string; ipAddress: string; siteId: string; expiresAt: number };

export function orphanedResultExpectationKey(agentId: string, commandId: string): string {
  return `${KEY_PREFIX}${agentId}:${commandId}`;
}

type ReadyRedis = NonNullable<ReturnType<typeof getRedis>>;

/** Fallback store, used only for records Redis could not take. Same keys as Redis. */
const localExpectations = new Map<string, OrphanedResultExpectation>();
/** Writes still in flight, so a read on this process never overtakes its own record. */
const pendingRecords = new Map<string, Promise<void>>();
let lastLocalPruneAt = Number.NEGATIVE_INFINITY;
let lastDegradedLogAt = Number.NEGATIVE_INFINITY;
let suppressedDegradedLogs = 0;

const TIMED_OUT = Symbol('timed-out');

/** Test hook: forget every record, in-flight write and the log rate-limit window. */
export function resetOrphanedResultExpectationsForTests(): void {
  localExpectations.clear();
  pendingRecords.clear();
  lastLocalPruneAt = Number.NEGATIVE_INFINITY;
  lastDegradedLogAt = Number.NEGATIVE_INFINITY;
  suppressedDegradedLogs = 0;
}

function logDegraded(level: 'warn' | 'error', message: string): void {
  const now = Date.now();
  if (now - lastDegradedLogAt < DEGRADED_LOG_INTERVAL_MS) {
    suppressedDegradedLogs += 1;
    return;
  }
  const suppressed = suppressedDegradedLogs;
  lastDegradedLogAt = now;
  suppressedDegradedLogs = 0;
  const tail = suppressed > 0 ? ` (${suppressed} similar event(s) suppressed since the last report)` : '';
  console[level](`[OrphanedResultExpectations] ${message}${tail}`);
}

function readyRedis(): { redis: ReadyRedis } | { reason: string } {
  let redis: ReturnType<typeof getRedis>;
  try {
    // Throws when the client cannot be built (an unreadable REDIS_PASSWORD_FILE).
    redis = getRedis();
  } catch (err) {
    return { reason: `Redis client could not be created: ${errorMessage(err)}` };
  }
  if (!redis) return { reason: 'no Redis client' };
  // `wait` is the lazy client before its first command, which connects it. A
  // client that is connecting, reconnecting or closed is skipped: its offline
  // queue would hold each call until the per-request retry limit runs out
  // (several seconds), far past the timeout above.
  if (redis.status !== 'ready' && redis.status !== 'wait') {
    return { reason: `Redis client is ${redis.status}` };
  }
  return { redis };
}

async function withTimeout<T>(run: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function live(expectation: OrphanedResultExpectation | null | undefined): OrphanedResultExpectation | null {
  return expectation && expectation.expiresAt > Date.now() ? expectation : null;
}

function pruneLocal(now = Date.now()): void {
  if (now - lastLocalPruneAt < LOCAL_PRUNE_INTERVAL_MS) return;
  lastLocalPruneAt = now;
  for (const [key, expectation] of localExpectations) {
    if (expectation.expiresAt <= now) localExpectations.delete(key);
  }
}

function holdLocally(key: string, expectation: OrphanedResultExpectation, reason: string): void {
  pruneLocal();
  localExpectations.set(key, expectation);
  logDegraded(
    'warn',
    `${reason}; holding dispatch records in-process. A result that reaches another API replica `
      + 'for one of them is rejected as unexpected.',
  );
}

async function writeExpectation(key: string, expectation: OrphanedResultExpectation): Promise<void> {
  const ready = readyRedis();
  if ('reason' in ready) {
    holdLocally(key, expectation, ready.reason);
    return;
  }
  const ttlMs = Math.max(1, expectation.expiresAt - Date.now());
  try {
    const outcome = await withTimeout(ready.redis.set(key, JSON.stringify(expectation), 'PX', ttlMs));
    if (outcome === TIMED_OUT) {
      holdLocally(key, expectation, `Redis write timed out after ${ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS} ms`);
    }
  } catch (err) {
    holdLocally(key, expectation, `Redis write failed: ${errorMessage(err)}`);
  }
}

/**
 * Record that `expectation.agentId` was sent `commandId`. Never rejects: a
 * record Redis cannot take is held in-process instead. The returned promise
 * settles once the record is stored; callers on the synchronous send path may
 * drop it, since a later read on this process waits for it anyway.
 */
export function recordOrphanedResultExpectation(
  commandId: string,
  expectation: OrphanedResultExpectation,
): Promise<void> {
  const key = orphanedResultExpectationKey(expectation.agentId, commandId);
  const write = writeExpectation(key, expectation);
  pendingRecords.set(key, write);
  const settle = () => {
    if (pendingRecords.get(key) === write) pendingRecords.delete(key);
  };
  // Both handlers, so even a future rejection here could never go unhandled.
  void write.then(settle, settle);
  return write;
}

const EXPECTATION_KINDS = new Set(['snmp', 'monitor', 'probe']);

function parseStored(raw: string, agentId: string, key: string): OrphanedResultExpectation | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  const record = value as Partial<Record<string, unknown>> | null;
  const valid = record !== null
    && typeof record === 'object'
    && record.agentId === agentId
    && typeof record.kind === 'string'
    && EXPECTATION_KINDS.has(record.kind)
    && typeof record.targetId === 'string'
    && typeof record.expiresAt === 'number'
    && (record.kind !== 'probe' || (typeof record.ipAddress === 'string' && typeof record.siteId === 'string'));
  if (!valid) {
    console.warn(`[OrphanedResultExpectations] Ignoring an unreadable expectation at ${key}`);
    return null;
  }
  return record as OrphanedResultExpectation;
}

async function readRemote(
  operation: 'peek' | 'consume',
  agentId: string,
  key: string,
): Promise<OrphanedResultExpectation | null> {
  const ready = readyRedis();
  if ('reason' in ready) {
    // A record another replica wrote (or this one wrote before the outage) may
    // be sitting in Redis; this process cannot see it.
    logDegraded('warn', `${operation} skipped Redis (${ready.reason}); results recorded there are treated as unexpected`);
    return null;
  }
  try {
    const raw = await withTimeout(operation === 'peek' ? ready.redis.get(key) : ready.redis.getdel(key));
    if (raw === TIMED_OUT) {
      logDegraded(
        'error',
        `${operation} timed out after ${ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS} ms at ${key}; treating the result as unexpected`,
      );
      return null;
    }
    return typeof raw === 'string' ? parseStored(raw, agentId, key) : null;
  } catch (err) {
    logDegraded('error', `${operation} failed at ${key}: ${errorMessage(err)}; treating the result as unexpected`);
    return null;
  }
}

/** The record for `agentId` + `commandId`, left in place; null when there is none. */
export async function peekOrphanedResultExpectation(
  agentId: string,
  commandId: string,
): Promise<OrphanedResultExpectation | null> {
  const key = orphanedResultExpectationKey(agentId, commandId);
  await pendingRecords.get(key);
  const local = live(localExpectations.get(key));
  if (local) return local;
  return live(await readRemote('peek', agentId, key));
}

/**
 * Take the record for `agentId` + `commandId`, so the same result cannot be
 * honored twice. Another agent's record under the same command id is never
 * returned and never removed.
 */
export async function consumeOrphanedResultExpectation(
  agentId: string,
  commandId: string,
): Promise<OrphanedResultExpectation | null> {
  const key = orphanedResultExpectationKey(agentId, commandId);
  await pendingRecords.get(key);
  pruneLocal();
  const local = localExpectations.get(key) ?? null;
  localExpectations.delete(key);
  const remote = await readRemote('consume', agentId, key);
  return live(local) ?? live(remote);
}
