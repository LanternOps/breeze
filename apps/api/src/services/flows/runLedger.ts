/**
 * Tool catalog W04 (#5219), plan Task A8 — pure decisions over the step
 * ledger (`flow_run_steps`). No I/O: the slice (runSlice.ts) reads the rows
 * and the parked intent, these functions say what they mean, and the slice
 * writes it through one fenced checkpoint.
 *
 * The ledger, not `current_step_id`, is the source of truth for where a run
 * is: the latest attempt per (step_id, item_index) says whether that unit is
 * done (completed / skipped / failed-and-continued), parked on an intent,
 * still `running` (a stalled slice), or must run again (a tier-1 attempt
 * marked `worker_lost`). That is what makes every resume — approval wake,
 * timed wake, stalled redelivery, slot retry — re-execute nothing that
 * already happened.
 */
import type { FlowRunErrorCode, FlowRunStatus, FlowValue } from '@breeze/shared';
import type { FlowRunStepRow } from '../../db/schema/flowRuns';
import type { ParkedIntentRow } from './runStore';
import { toStoredFlowOutput } from './storedOutput';

export type LedgerKey = string;

export function ledgerKey(stepId: string, itemIndex: number | null): LedgerKey {
  return `${stepId}\u0000${itemIndex ?? -1}`;
}

/** The newest attempt of every (step, item). */
export function latestAttempts(rows: readonly FlowRunStepRow[]): Map<LedgerKey, FlowRunStepRow> {
  const out = new Map<LedgerKey, FlowRunStepRow>();
  for (const row of rows) {
    const key = ledgerKey(row.stepId, row.itemIndex ?? null);
    const prev = out.get(key);
    if (!prev || row.attempt > prev.attempt) out.set(key, row);
  }
  return out;
}

/** A tier-1 attempt the stalled-slice rule closed; the unit runs again as attempt + 1. */
export function isRetryMarker(row: FlowRunStepRow): boolean {
  return row.status === 'failed' && row.errorCode === 'worker_lost';
}

export const WORKER_LOST_RETRY_TEXT = 'The worker running this step stopped before it finished; the step is retried.';
export const WORKER_LOST_UNKNOWN_TEXT =
  'The worker running this step stopped before it finished. The step may have taken effect, so it is not retried.';

/** A step-row write (values for `updateStepRow`). */
export type StepRowValues = Partial<FlowRunStepRow>;

export interface RunEnd {
  status: Extract<FlowRunStatus, 'failed' | 'cancelled' | 'expired'>;
  errorCode: FlowRunErrorCode | null;
  error: string;
}

/**
 * What a parked step's intent means for the run (plan Task A8 step 4).
 *  - `pending`  — not terminal yet (pending_approval / approved / executing): a spurious wake.
 *  - `continue` — the step is resolved and the run goes on (approved and done;
 *                 or failed under onFailure 'continue').
 *  - `end`      — the step's resolution ends the run.
 */
export type ParkedResolution =
  | { kind: 'pending' }
  | { kind: 'continue'; step: StepRowValues; status: 'completed' | 'failed'; output: FlowValue | null }
  | { kind: 'end'; step: StepRowValues; run: RunEnd; unknownOutcome: boolean };

const INTENT_IN_FLIGHT: ReadonlySet<string> = new Set(['pending_approval', 'approved', 'executing']);

export function resolveParkedIntent(
  intent: ParkedIntentRow | null,
  ctx: { stepId: string; onFailure: 'stop' | 'continue'; cancelRequested: boolean; now: Date },
): ParkedResolution {
  const finishedAt = ctx.now;
  if (!intent) {
    return {
      kind: 'end',
      step: { status: 'failed', errorCode: 'drift', error: 'The approval request for this step no longer exists.', finishedAt },
      run: { status: 'failed', errorCode: 'drift', error: `The approval request for step ${ctx.stepId} no longer exists.` },
      unknownOutcome: false,
    };
  }
  if (INTENT_IN_FLIGHT.has(intent.status)) return { kind: 'pending' };

  switch (intent.status) {
    case 'completed': {
      const stored = toStoredFlowOutput((intent.result ?? {}) as FlowValue);
      return {
        kind: 'continue',
        status: 'completed',
        output: stored.output,
        step: {
          status: 'completed',
          output: stored.output,
          outputTruncated: stored.truncated,
          approvedByUserId: intent.decidedByUserId,
          finishedAt,
        },
      };
    }
    case 'rejected':
      return {
        kind: 'end',
        step: { status: 'failed', errorCode: 'rejected', error: 'The step was rejected by an approver.', finishedAt },
        run: { status: 'failed', errorCode: 'rejected', error: `Step ${ctx.stepId} was rejected by an approver.` },
        unknownOutcome: false,
      };
    case 'expired':
      return {
        kind: 'end',
        step: { status: 'cancelled', errorCode: 'cancelled', error: 'No one approved the step before the approval expired.', finishedAt },
        run: { status: 'expired', errorCode: null, error: `No one approved step ${ctx.stepId} before the approval expired.` },
        unknownOutcome: false,
      };
    case 'cancelled': {
      const code = intent.errorCode ?? '';
      if (code.startsWith('no_eligible_approvers')) {
        return {
          kind: 'end',
          step: { status: 'failed', errorCode: 'no_eligible_approvers', error: 'No one is eligible to approve this step.', finishedAt },
          run: { status: 'failed', errorCode: 'no_eligible_approvers', error: `No one is eligible to approve step ${ctx.stepId}.` },
          unknownOutcome: false,
        };
      }
      if (ctx.cancelRequested) {
        return {
          kind: 'end',
          step: { status: 'cancelled', errorCode: 'cancelled', error: 'The run was cancelled while the step waited for approval.', finishedAt },
          run: { status: 'cancelled', errorCode: 'cancelled', error: 'The run was cancelled.' },
          unknownOutcome: false,
        };
      }
      if (code === 'flow_drift') {
        // A refused dispatch claim normally terminalizes the run itself; this
        // is the case it left to us (run_not_waiting).
        return {
          kind: 'end',
          step: { status: 'failed', errorCode: 'drift', error: 'The approved step no longer matched the flow.', finishedAt },
          run: { status: 'failed', errorCode: 'drift', error: `The approved step ${ctx.stepId} no longer matched the flow.` },
          unknownOutcome: false,
        };
      }
      return {
        kind: 'end',
        step: { status: 'cancelled', errorCode: 'cancelled', error: 'The approval request was cancelled.', finishedAt },
        run: { status: 'cancelled', errorCode: 'cancelled', error: `The approval request for step ${ctx.stepId} was cancelled.` },
        unknownOutcome: false,
      };
    }
    case 'failed': {
      // Decision 5: an execution that may have happened is never retried or
      // skipped past — unknown_outcome fails the run regardless of onFailure.
      const mayHaveRun = (intent.errorCode === 'execution_error' && intent.executedAt !== null)
        || intent.errorCode === 'execution_lost';
      if (mayHaveRun) {
        return {
          kind: 'end',
          step: {
            status: 'unknown_outcome',
            errorCode: 'unknown_outcome',
            error: 'The approved step failed while it ran; it may have taken effect.',
            approvedByUserId: intent.decidedByUserId,
            finishedAt,
          },
          run: { status: 'failed', errorCode: 'unknown_outcome', error: `Step ${ctx.stepId} may or may not have taken effect.` },
          unknownOutcome: true,
        };
      }
      const step: StepRowValues = {
        status: 'failed',
        errorCode: 'step_failed',
        error: `The approved step failed before it ran (${intent.errorCode ?? 'unknown'}).`,
        approvedByUserId: intent.decidedByUserId,
        finishedAt,
      };
      return ctx.onFailure === 'continue'
        ? { kind: 'continue', status: 'failed', output: null, step }
        : { kind: 'end', step, run: { status: 'failed', errorCode: 'step_failed', error: `Step ${ctx.stepId} failed.` }, unknownOutcome: false };
    }
    default:
      return { kind: 'pending' };
  }
}

/**
 * Step-row writes that close every OPEN row when a run ends before its next
 * step (preconditions: flag off, delegator, drift, disable, cancel). A parked
 * row is cancelled; a `running` row of a dead slice is `worker_lost` (tier 1)
 * or `unknown_outcome` (tier ≥ 2 — it may have taken effect).
 */
export function closeOpenRows(
  rows: Iterable<FlowRunStepRow>,
  now: Date,
): { updates: Array<{ id: string; values: StepRowValues }>; unknownStepIds: string[] } {
  const updates: Array<{ id: string; values: StepRowValues }> = [];
  const unknownStepIds: string[] = [];
  for (const row of rows) {
    if (row.status === 'awaiting_approval') {
      updates.push({ id: row.id, values: { status: 'cancelled', errorCode: 'cancelled', error: 'The run ended while the step waited for approval.', finishedAt: now } });
    } else if (row.status === 'running') {
      if (row.tier === 1) {
        updates.push({ id: row.id, values: { status: 'failed', errorCode: 'worker_lost', error: 'The run ended after the worker running this step stopped.', finishedAt: now } });
      } else {
        unknownStepIds.push(row.stepId);
        updates.push({ id: row.id, values: { status: 'unknown_outcome', errorCode: 'unknown_outcome', error: WORKER_LOST_UNKNOWN_TEXT, finishedAt: now } });
      }
    }
  }
  return { updates, unknownStepIds };
}
