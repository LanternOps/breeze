/**
 * Inline fix-outcome advance from the two script terminal-write paths (AI
 * Suggested Fixes W1, decision D-a). Deliberately NOT the public
 * script.completed/script.failed events: those feed customer automations and
 * webhooks and are emitted after commit (services/scriptTerminalEvents.ts, #7277),
 * whereas this advances fix_outcomes inline in the caller's transaction.
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
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS } from '@breeze/shared';
import { db, hasDbAccessContext, withDbTransaction } from '../../db';
import { fixOutcomes } from '../../db/schema';
import { captureException } from '../sentry';

export type ScriptTerminalStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';
/** A caller's open transaction handle (or the ambient db). `transaction` is required: the hook opens its savepoint on it. */
export type OutcomeUpdateExecutor = Pick<typeof db, 'update' | 'transaction'>;
type OutcomeWriter = Pick<typeof db, 'update'>;

/**
 * The recovery window opens when the fix finished, not when a writer or sweep
 * noticed (#7279): a sweeper running behind must not hand the condition extra
 * time to clear. A completion time later than `now` (clock skew) or unknown
 * falls back to `now`. Shared with the sweeper's decidePending.
 */
export function recoveryDeadlineFrom(completedAt: Date | null | undefined, now: Date): Date {
  const from = completedAt && completedAt.getTime() < now.getTime() ? completedAt : now;
  return new Date(from.getTime() + FIX_OUTCOME_WINDOWS.recoveryTimeoutHours * 3_600_000);
}

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

/**
 * Pending verdicts a SERVER sweep writes without the agent's result: the
 * reaper's "no response" (failed / timeout) and its delivery-clock expiry
 * (never delivered). Only these can be contradicted by a late agent result.
 */
export const SERVER_SWEEP_VERDICT_REASONS = ['script_failed', 'script_timeout', 'script_never_delivered'] as const;
export const LATE_SUCCESS_REASON = 'script_succeeded_late';

/**
 * #7279 — the agent's REAL result for an execution a server sweep already
 * terminalised (handleScriptResult's #3607 recovery, the only caller passing
 * `lateResult`). The attempt was decided on the sweep's guess, so it is
 * reconciled with what actually happened:
 *  - the script succeeded → re-open it to awaiting_recovery (uncounted again;
 *    the recovery window opens at the late completion);
 *  - it failed → an inconclusive "never delivered" becomes a counted failure.
 *    A counted failure stays as it is (same count, original terminal_at).
 * Both set recount_requested_at: the sweeper's recount (recomputeForOutcome,
 * which also takes uncounted rows) recomputes the identity, so a failure that
 * was counted is dropped and a new one is added. The CAS is the sweep verdict
 * itself (state + reason + counted_at IS NOT NULL), so a duplicate frame, or an
 * attempt something else already moved on, matches nothing.
 */
function lateResultWrites(
  status: ScriptTerminalStatus, completedAt: Date | null | undefined, now: Date,
): Array<{ set: Partial<typeof fixOutcomes.$inferInsert>; from: { states: Array<'failed' | 'inconclusive'>; reasons: string[] } }> {
  const real = terminalVerdict(status);
  if (real.state === 'awaiting_recovery') {
    return [{
      set: {
        state: 'awaiting_recovery', stateReason: LATE_SUCCESS_REASON, terminalAt: null, countedAt: null,
        deadlineAt: recoveryDeadlineFrom(completedAt, now), recountRequestedAt: now, updatedAt: now,
      },
      from: { states: ['failed', 'inconclusive'], reasons: [...SERVER_SWEEP_VERDICT_REASONS] },
    }];
  }
  if (real.state === 'failed') {
    return [{
      set: { state: 'failed', stateReason: real.reason, terminalAt: now, recountRequestedAt: now, updatedAt: now },
      from: { states: ['inconclusive'], reasons: ['script_never_delivered'] },
    }];
  }
  return [];
}

/**
 * `completedAt` is the execution's completion time as the caller wrote it; the
 * recovery window is measured from it (#7279), clamped to now. `lateResult`:
 * the caller is recording the agent's real result onto an execution a server
 * sweep already terminalised (see lateResultWrites).
 */
export async function advanceOutcomesForTerminalExecution(
  input: { executionId: string; status: ScriptTerminalStatus; neverDelivered?: boolean; completedAt?: Date | null; lateResult?: boolean },
  executor?: OutcomeUpdateExecutor,
): Promise<number> {
  const verdict = terminalVerdict(input.status, { neverDelivered: input.neverDelivered });
  const now = new Date();
  const set: Partial<typeof fixOutcomes.$inferInsert> = verdict.state === 'awaiting_recovery'
    ? { state: verdict.state, stateReason: verdict.reason, updatedAt: now, deadlineAt: recoveryDeadlineFrom(input.completedAt, now) }
    : { state: verdict.state, stateReason: verdict.reason, updatedAt: now, terminalAt: now, countedAt: now, recountRequestedAt: now };
  const late = input.lateResult ? lateResultWrites(input.status, input.completedAt, now) : [];
  const write = async (ex: OutcomeWriter) => {
    const rows = await ex.update(fixOutcomes).set(set).where(and(
      eq(fixOutcomes.scriptExecutionId, input.executionId),
      eq(fixOutcomes.state, 'pending'),
      isNull(fixOutcomes.countedAt),
    )).returning({ id: fixOutcomes.id });
    let advanced = rows.length;
    for (const w of late) {
      const reconciled = await ex.update(fixOutcomes).set(w.set).where(and(
        eq(fixOutcomes.scriptExecutionId, input.executionId),
        inArray(fixOutcomes.state, w.from.states),
        inArray(fixOutcomes.stateReason, w.from.reasons),
        isNotNull(fixOutcomes.countedAt),
      )).returning({ id: fixOutcomes.id });
      advanced += reconciled.length;
    }
    return advanced;
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
    if (input.lateResult) {
      // No retry exists for this one: the sweeper re-reads only active rows,
      // and the #3607 recovery that carried the agent's result has already
      // consumed the swept execution, so the attempt keeps the sweep's verdict.
      console.error(`[fixMemory] late-result reconcile failed for execution ${input.executionId}; the attempt keeps the sweep's verdict:`, err);
      captureException(err, undefined, { component: 'fixMemory.scriptTerminalHook', phase: 'late_result_reconcile', executionId: input.executionId });
    } else {
      console.error(`[fixMemory] inline outcome advance failed for execution ${input.executionId}; the sweeper will retry:`, err);
    }
    return 0;
  }
}
