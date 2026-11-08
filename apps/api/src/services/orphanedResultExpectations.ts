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
 * out. That keeps a
 * single-replica deployment working as it did before. A record held locally can
 * only be honored by this process, so the first fallback in each outage is
 * logged (once, until a Redis write succeeds again).
 *
 * Reads always check both stores and consume from both. A write that timed out
 * may still land in Redis after its local copy was taken, and reading both is
 * what keeps that record single-use.
 */
import { getRedis } from './redis';

export const ORPHANED_RESULT_EXPECTATION_TTL_MS = 30 * 60 * 1000;

/**
 * Upper bound on one Redis call. The read runs inside the short org-scoped
 * transaction that handles an orphaned result, so it holds a pooled DB
 * connection while it waits.
 */
export const ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS = 500;

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
let fallbackLogged = false;

const TIMED_OUT = Symbol('timed-out');

/** Test hook: forget every record, in-flight write and the fallback log latch. */
export function resetOrphanedResultExpectationsForTests(): void {
  localExpectations.clear();
  pendingRecords.clear();
  fallbackLogged = false;
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
  // queue would hold every call for as long as the retry strategy runs.
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

function pruneLocal(now = Date.now()): void {
  for (const [key, expectation] of localExpectations) {
    if (expectation.expiresAt <= now) localExpectations.delete(key);
  }
}

function holdLocally(key: string, expectation: OrphanedResultExpectation, reason: string): void {
  pruneLocal();
  localExpectations.set(key, expectation);
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.warn(
    `[OrphanedResultExpectations] ${reason}; holding dispatch records in-process until a Redis write succeeds. `
      + 'A result that reaches another API replica in that window is rejected as unexpected.',
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
      return;
    }
    fallbackLogged = false;
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
  void write.finally(() => {
    if (pendingRecords.get(key) === write) pendingRecords.delete(key);
  });
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
  // Nothing to report: whatever this process recorded during the outage is in
  // the local store, and the caller's own rejection log covers a miss.
  if ('reason' in ready) return null;
  try {
    const raw = await withTimeout(operation === 'peek' ? ready.redis.get(key) : ready.redis.getdel(key));
    if (raw === TIMED_OUT) {
      console.error(
        `[OrphanedResultExpectations] ${operation} timed out after ${ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS} ms at ${key}; `
          + 'treating the result as unexpected',
      );
      return null;
    }
    return typeof raw === 'string' ? parseStored(raw, agentId, key) : null;
  } catch (err) {
    console.error(
      `[OrphanedResultExpectations] ${operation} failed at ${key}: ${errorMessage(err)}; treating the result as unexpected`,
    );
    return null;
  }
}

function live(expectation: OrphanedResultExpectation | null | undefined): OrphanedResultExpectation | null {
  return expectation && expectation.expiresAt > Date.now() ? expectation : null;
}

/** The record for `agentId` + `commandId`, left in place; null when there is none. */
export async function peekOrphanedResultExpectation(
  agentId: string,
  commandId: string,
): Promise<OrphanedResultExpectation | null> {
  const key = orphanedResultExpectationKey(agentId, commandId);
  await pendingRecords.get(key);
  pruneLocal();
  const local = localExpectations.get(key);
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
  return live(local ?? remote);
}
