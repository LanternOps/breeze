/**
 * Inline fix-outcome advance from the two script terminal-write paths (AI
 * Suggested Fixes W1, decision D-a). Deliberately NOT the public
 * script.completed/script.failed events: those feed customer automations and
 * webhooks with no loop guard (separate follow-up issue).
 *
 * Runs in the CALLER's transaction and touches only fix_outcomes (the org's own
 * rows): the agent-result path is org-scoped and must not open a second pooled
 * system connection (#1105) nor write partner fix_memory rows. A terminal
 * verdict sets recount_requested_at; the sweeper recomputes the aggregate under
 * system scope. The CAS (state = 'pending' AND counted_at IS NULL) makes this
 * path and the sweeper mutually exclusive — whichever lands second matches 0.
 * NEVER throws, and NEVER aborts the caller's transaction: every write runs in
 * a savepoint (see advanceOutcomesForTerminalExecution).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS } from '@breeze/shared';
import { db, hasDbAccessContext, withDbTransaction } from '../../db';
import { fixOutcomes } from '../../db/schema';

export type ScriptTerminalStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';
/** A caller's open transaction handle (or the ambient db). `transaction` is required: the hook opens its savepoint on it. */
export type OutcomeUpdateExecutor = Pick<typeof db, 'update' | 'transaction'>;
type OutcomeWriter = Pick<typeof db, 'update'>;

/**
 * `neverDelivered`: the caller KNOWS the script never reached the device (the
 * reaper's delivery clock expired it — staleCommandReaper
 * propagateTimedOutDeviceCommand, kind 'expired'). That says nothing about
 * whether the fix works, so a failed/timed-out verdict becomes inconclusive
 * instead of a failed attempt. A script that started and then failed stays failed.
 */
export function terminalVerdict(
  status: ScriptTerminalStatus,
  opts: { neverDelivered?: boolean } = {},
): { state: 'awaiting_recovery' | 'failed' | 'cancelled' | 'inconclusive'; reason: string } {
  if (opts.neverDelivered && (status === 'failed' || status === 'timeout')) {
    return { state: 'inconclusive', reason: 'script_never_delivered' };
  }
  switch (status) {
    case 'completed': return { state: 'awaiting_recovery', reason: 'script_succeeded' };
    case 'failed': return { state: 'failed', reason: 'script_failed' };
    case 'timeout': return { state: 'failed', reason: 'script_timeout' };
    case 'cancelled': return { state: 'cancelled', reason: 'script_cancelled' };
  }
}

export async function advanceOutcomesForTerminalExecution(
  input: { executionId: string; status: ScriptTerminalStatus; neverDelivered?: boolean },
  executor?: OutcomeUpdateExecutor,
): Promise<number> {
  const verdict = terminalVerdict(input.status, { neverDelivered: input.neverDelivered });
  const now = new Date();
  const set: Partial<typeof fixOutcomes.$inferInsert> = verdict.state === 'awaiting_recovery'
    ? { state: verdict.state, stateReason: verdict.reason, updatedAt: now,
        deadlineAt: new Date(now.getTime() + FIX_OUTCOME_WINDOWS.recoveryTimeoutHours * 3_600_000) }
    : { state: verdict.state, stateReason: verdict.reason, updatedAt: now, terminalAt: now, countedAt: now, recountRequestedAt: now };
  const write = async (ex: OutcomeWriter) => {
    const rows = await ex.update(fixOutcomes).set(set).where(and(
      eq(fixOutcomes.scriptExecutionId, input.executionId),
      eq(fixOutcomes.state, 'pending'),
      isNull(fixOutcomes.countedAt),
    )).returning({ id: fixOutcomes.id });
    return rows.length;
  };
  // The catch is OUTSIDE the savepoint on purpose. A PostgreSQL error aborts the
  // whole enclosing transaction even when the JS error is caught (25P02 on every
  // later statement, rollback at commit). Only a driver-owned savepoint that
  // rolls back before we swallow the error keeps the caller's transaction usable.
  try {
    if (executor) {
      // Caller's open transaction: cancel propagation
      // (commandCancelPropagation.ts, incl. the heartbeat claim's
      // claim-time-ineligibility cancel in commandClaimEligibility.ts) via
      // finalizeScriptExecutionTerminal. The reaper passes no executor; it takes
      // the ambient-db branch below. Drizzle's nested `transaction` on a tx
      // handle, or on the ambient db inside a context, is a SAVEPOINT: the same
      // mechanism as withDbTransaction (db/index.ts). Never write on `executor` directly.
      return await executor.transaction((savepoint) => write(savepoint as unknown as OutcomeWriter));
    }
    // Ambient db inside the ingest transaction: a SAVEPOINT, as evaluateScriptExitCodeAlert does.
    return hasDbAccessContext() ? await withDbTransaction(() => write(db)) : await write(db);
  } catch (err) {
    console.error(`[fixMemory] inline outcome advance failed for execution ${input.executionId}; the sweeper will retry:`, err);
    return 0;
  }
}
