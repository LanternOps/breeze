/**
 * Wave 6.2a (#3828) — the circuit ledger's WRITER.
 *
 * INERT IN THIS WAVE. Counters accumulate here and a circuit can reach the
 * `open` state, but no code path reads that state to make a decision. Wave
 * 6.2b adds the enforcing gate — and it has to add it in THREE places, not
 * one, because "downgrade to propose" does not mean "a human must approve" in
 * Breeze: a tier-3 proposal becomes an action intent (`recordProposal` ->
 * `createActionIntent`), and `attemptPolicyDecision` can authorize that intent
 * unattended for anything in `POLICY_DECIDABLE_TIER3` — which includes
 * `manage_services:restart`, the exact op this wave watches. Gating only the
 * act branch would let the breaker route around itself. See the plan doc,
 * decision 11.
 *
 * `epoch` is the anti-resurrection guard. A manual reset bumps it; a sweeper
 * that read the epoch when it CLAIMED a watch may only apply its result if the
 * epoch still holds when it finalizes. That window is exactly where the
 * bounded device read happens (outside any transaction), so it is exactly
 * where a human clearing the breaker could otherwise be silently undone.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  aiAgentCircuits,
  type AiAgentCircuitRow,
} from '../../db/schema/aiAgentFixWatches';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Consecutive failures on ONE target before the breaker opens.
 *
 * Three, not two: a remediation that fails once is ordinary, and twice can
 * still be one underlying incident being re-triggered. Three says the agent's
 * chosen fix does not work on this target. Belongs in the (already
 * partner-wide) agent policy surface once it needs to vary per partner — it is
 * a constant here deliberately, so 6.2a ships no new configuration.
 */
export const CIRCUIT_FAILURE_THRESHOLD = 3;

/**
 * Failures older than this stop counting. Without a decaying window a target
 * that fails once a month for three months would eventually open a breaker on
 * evidence that is no longer about the same system.
 */
export const CIRCUIT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CircuitKey {
  orgId: string;
  agentId: string;
  deviceId: string;
  opKey: string;
  targetFingerprint: string;
}

/** What moved the counter — recorded so an operator can see WHY it opened. */
export type CircuitFailureSource = 'verify_failed' | 'fix_regressed';

export interface RecordCircuitFailureArgs extends CircuitKey {
  source: CircuitFailureSource;
  /** Short, human-readable — never a raw tool input/output blob. */
  reason: string;
  /**
   * The epoch read when the caller claimed its work. The write is skipped if
   * the circuit has been reset since. Omit for a synchronous caller that never
   * left the DB (an immediate verify failure), which has no such window.
   */
  expectedEpoch?: number;
  now?: Date;
}

export interface RecordCircuitFailureResult {
  applied: boolean;
  /** True only on the transition, so the caller notifies exactly once. */
  opened: boolean;
  failureCount: number;
  state: AiAgentCircuitRow['state'];
}

/**
 * Increments the failure counter for one target, opening the breaker when the
 * threshold is crossed inside the decay window.
 *
 * Idempotent-safe under concurrency via the unique target index: two racing
 * inserts collapse to one row, and the increment happens in the conflict
 * branch rather than in a read-then-write.
 */
export async function recordCircuitFailure(
  args: RecordCircuitFailureArgs,
): Promise<RecordCircuitFailureResult> {
  const { orgId, agentId, deviceId, opKey, targetFingerprint, source, reason } = args;
  const now = args.now ?? new Date();
  // ISO strings, not Date objects, for the raw `sql` interpolations below.
  // Drizzle serializes a Date correctly when it flows through a typed column
  // (`.values({...})`/`.set({...})`), but a bare `${date}` inside a sql template
  // reaches the postgres driver untouched and its Bind step throws
  // ERR_INVALID_ARG_TYPE. The explicit ::timestamptz cast keeps the comparison
  // typed rather than relying on inference from a text literal.
  const windowFloor = new Date(now.getTime() - CIRCUIT_FAILURE_WINDOW_MS).toISOString();
  const nowIso = now.toISOString();

  return inSystemDbContext(async () => {
    const [row] = await db
      .insert(aiAgentCircuits)
      .values({
        orgId,
        agentId,
        deviceId,
        opKey,
        targetFingerprint,
        failureCount: 1,
        windowStartedAt: now,
        lastFailureAt: now,
        lastFailureReason: reason,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          aiAgentCircuits.orgId,
          aiAgentCircuits.agentId,
          aiAgentCircuits.deviceId,
          aiAgentCircuits.opKey,
          aiAgentCircuits.targetFingerprint,
        ],
        set: {
          // Restart the count when the previous window has decayed, otherwise
          // add to it. Done in SQL so the read and the write are one statement.
          failureCount: sql`CASE
            WHEN ${aiAgentCircuits.windowStartedAt} < ${windowFloor}::timestamptz THEN 1
            ELSE ${aiAgentCircuits.failureCount} + 1
          END`,
          windowStartedAt: sql`CASE
            WHEN ${aiAgentCircuits.windowStartedAt} < ${windowFloor}::timestamptz THEN ${nowIso}::timestamptz
            ELSE ${aiAgentCircuits.windowStartedAt}
          END`,
          lastFailureAt: now,
          lastFailureReason: reason,
          updatedAt: now,
        },
        // The stale-result guard. A caller that supplied an epoch only lands
        // its write while that epoch still holds; a manual reset in the
        // meantime makes this a silent no-op rather than a resurrection.
        setWhere: args.expectedEpoch === undefined
          ? undefined
          : eq(aiAgentCircuits.epoch, args.expectedEpoch),
      })
      .returning();

    if (!row) {
      // No row came back: the conflict branch's `setWhere` refused the write,
      // i.e. the circuit was reset while this result was in flight.
      return { applied: false, opened: false, failureCount: 0, state: 'closed' as const };
    }

    const shouldOpen = row.state === 'closed' && row.failureCount >= CIRCUIT_FAILURE_THRESHOLD;
    if (!shouldOpen) {
      return {
        applied: true, opened: false, failureCount: row.failureCount, state: row.state,
      };
    }

    // Separate statement, guarded on `state` still being 'closed', so two
    // concurrent finalizers cannot both report the open transition (and so the
    // operator is not notified twice).
    const [opened] = await db
      .update(aiAgentCircuits)
      .set({
        state: 'open',
        openedAt: now,
        openReason: `${source}: ${reason}`,
        consecutiveOpens: sql`${aiAgentCircuits.consecutiveOpens} + 1`,
        updatedAt: now,
      })
      .where(and(eq(aiAgentCircuits.id, row.id), eq(aiAgentCircuits.state, 'closed')))
      .returning();

    return {
      applied: true,
      opened: Boolean(opened),
      failureCount: row.failureCount,
      state: opened ? 'open' : row.state,
    };
  });
}

/**
 * A fix that held clears the accumulated failures for that target.
 *
 * Deliberately does NOT close an already-open breaker: in this program there
 * is no automatic half-open probe, so while a circuit is open the agent is not
 * supposed to be acting on that target at all (6.2b), and a `held` result
 * arriving against an open circuit is therefore evidence about a run that
 * predates the opening — not evidence that the breaker can be lifted. Only a
 * human closes it.
 */
export async function recordCircuitSuccess(key: CircuitKey, now = new Date()): Promise<void> {
  await inSystemDbContext(async () => {
    await db
      .update(aiAgentCircuits)
      .set({ failureCount: 0, windowStartedAt: now, updatedAt: now })
      .where(and(
        eq(aiAgentCircuits.orgId, key.orgId),
        eq(aiAgentCircuits.agentId, key.agentId),
        eq(aiAgentCircuits.deviceId, key.deviceId),
        eq(aiAgentCircuits.opKey, key.opKey),
        eq(aiAgentCircuits.targetFingerprint, key.targetFingerprint),
        eq(aiAgentCircuits.state, 'closed'),
      ));
  });
}

/**
 * Reads the current epoch for a target, or 0 when no circuit exists yet.
 * Callers capture this when they CLAIM work and hand it back to
 * `recordCircuitFailure` when they finalize.
 */
export async function readCircuitEpoch(key: CircuitKey): Promise<number> {
  const [row] = await db
    .select({ epoch: aiAgentCircuits.epoch })
    .from(aiAgentCircuits)
    .where(and(
      eq(aiAgentCircuits.orgId, key.orgId),
      eq(aiAgentCircuits.agentId, key.agentId),
      eq(aiAgentCircuits.deviceId, key.deviceId),
      eq(aiAgentCircuits.opKey, key.opKey),
      eq(aiAgentCircuits.targetFingerprint, key.targetFingerprint),
    ))
    .limit(1);
  return row?.epoch ?? 0;
}
