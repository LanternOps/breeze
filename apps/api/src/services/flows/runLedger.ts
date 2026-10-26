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
import { FLOW_STEP_ERROR_CODES, type FlowRunErrorCode, type FlowRunStatus, type FlowStepErrorCode, type FlowValue } from '@breeze/shared';
import type { FlowRunStepRow } from '../../db/schema/flowRuns';
import type { ParkedIntentRow } from './runStore';
import { toStoredFlowOutput } from './storedOutput';

export type LedgerKey = string;

// ── what a tool result means ────────────────────────────────────────────────

/**
 * What a core tool's parsed result says happened. Shared by the step executor
 * (stepExecutor.ts re-exports it) and the approval wake below, so a step that
 * ran directly and the same step released by an approver are recorded the
 * same way.
 *  - `ok`            — the call did what it was asked.
 *  - `error`         — the tool reported a definite failure.
 *  - `may_still_run` — the call returned but the effect may still be in
 *                      progress (run_script: the server stopped waiting on a
 *                      device — `waitForCommandResult` writes `timedOutBy:
 *                      'server'` — or the device reported `status: 'timeout'`).
 *                      Tier >= 2 records it `unknown_outcome`.
 *  - `nothing_ran`   — the call did nothing: every run_script device was
 *                      suppressed by a maintenance window (or refused). Not
 *                      an error shape on the tool side (#4919), but an
 *                      unattended flow must not record it as completed.
 */
export type ToolResultClass =
  | { kind: 'ok' }
  | { kind: 'error' }
  | { kind: 'may_still_run'; message: string }
  | { kind: 'nothing_ran'; message: string };

const RESULT_OK: ToolResultClass = { kind: 'ok' };
const RESULT_ERROR: ToolResultClass = { kind: 'error' };
/** Tools whose result the classifier reads per device: a stored result without them cannot be verified. */
const PER_DEVICE_RESULT_TOOLS: ReadonlySet<string> = new Set(['run_script']);
export const RESULT_TOO_LARGE_TEXT =
  'The step ran, but its result was too large to store, so whether every device finished could not be verified. It may have taken effect.';
export const MAY_STILL_RUN_TEXT =
  'The script did not report back before the server stopped waiting; it may still be running on the device.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifyToolResult(tool: string, value: unknown): ToolResultClass {
  if (!isRecord(value)) return RESULT_OK;
  // `{ success: false, error }` lands here too: the release worker's
  // `isReturnedToolError` exempts any result carrying `success`/`data`/
  // `configured`, so such a result can arrive on a COMPLETED intent.
  if ('error' in value && value.error !== null && value.error !== undefined && value.error !== false) return RESULT_ERROR;
  if (tool === 'run_script' && isRecord(value.results)) {
    const perDevice = Object.values(value.results);
    if (perDevice.length === 0) return RESULT_OK;
    // Checked BEFORE the all-errored rule: a timed-out device also carries an
    // `error` string, but its script may still be running.
    if (perDevice.some((r) => isRecord(r) && (r.timedOutBy === 'server' || r.status === 'timeout'))) {
      return { kind: 'may_still_run', message: MAY_STILL_RUN_TEXT };
    }
    const refused = (r: unknown) => isRecord(r) && typeof r.error === 'string';
    const suppressed = (r: unknown) => isRecord(r) && r.status === 'suppressed';
    // Every targeted device refused or failed to dispatch: the call did nothing.
    if (perDevice.every(refused)) return RESULT_ERROR;
    if (perDevice.every((r) => refused(r) || suppressed(r))) {
      return {
        kind: 'nothing_ran',
        message: perDevice.every(suppressed)
          ? 'The script did not run: every targeted device is in a maintenance window.'
          : 'The script did not run: every targeted device was in a maintenance window or refused it.',
      };
    }
  }
  return RESULT_OK;
}

/** A parsed core-tool result that reports a definite failure. */
export function isErrorResult(tool: string, value: unknown): boolean {
  return classifyToolResult(tool, value).kind === 'error';
}

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

function clipText(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

const FLOW_STEP_ERROR_CODE_SET: ReadonlySet<string> = new Set(FLOW_STEP_ERROR_CODES);

/**
 * W5 (#5220): the step error a released built-in recorded on its failed
 * intent (`{ error, flowStepError: { code, policy } }`, builtins/release.ts).
 * Null for anything else — an unknown code falls back to W04's generic path.
 */
function builtinStepErrorOf(result: Record<string, unknown> | null): { code: FlowStepErrorCode; message: string; policy: boolean } | null {
  const e = result?.flowStepError;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const { code, policy } = e as { code?: unknown; policy?: unknown };
  if (typeof code !== 'string' || !FLOW_STEP_ERROR_CODE_SET.has(code) || typeof policy !== 'boolean') return null;
  const message = typeof result?.error === 'string' && result.error.length > 0 ? clipText(result.error) : 'The approved step failed.';
  return { code: code as FlowStepErrorCode, message, policy };
}

/** The error a returned tool result carries, for the step row. */
function resultErrorText(result: Record<string, unknown> | null): string {
  const err = result?.error;
  if (typeof err === 'string' && err.length > 0) return clipText(err);
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    return clipText((err as { message: string }).message);
  }
  return 'every targeted device refused it';
}

/**
 * `tool` / `toolSource` are the parked step row's: they decide how a released
 * result is read (run_script answers per device). A TENANT tool's result is
 * never re-classified — its own `isError` already decided the intent's status
 * (the release worker's `externalIsError`), exactly as the executor trusts it
 * on the direct path.
 */
export function resolveParkedIntent(
  intent: ParkedIntentRow | null,
  ctx: {
    stepId: string;
    tool: string;
    toolSource: string;
    onFailure: 'stop' | 'continue';
    cancelRequested: boolean;
    now: Date;
  },
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
      // Review finding 4: `completed` is the release worker's verdict, not
      // ours — its `isReturnedToolError` exempts any result carrying
      // `success`/`data`/`configured`, so `{ success: false, error }` (and a
      // run_script whose every device failed, timed out or sat in a
      // maintenance window) arrive here as COMPLETED. Read the result with
      // the executor's own classifier so a released step is recorded exactly
      // as the same step executed directly would be. Only tier-3 steps park,
      // so tier >= 2 always applies:
      //   error / nothing_ran ⇒ a definite failure (`step_failed`; the tool
      //                         answered — onFailure applies, as in the
      //                         executor);
      //   may_still_run       ⇒ `unknown_outcome` (the run fails regardless
      //                         of onFailure, Decision 5).
      // Round-2 review: the release worker stores a result over
      // MAX_RESULT_BYTES as `{ truncated: true }`. For a tool read per device
      // the verdict is gone with it (a timed-out device is invisible), so
      // fail closed: may have taken effect.
      const truncatedPerDevice = ctx.toolSource !== 'tenant'
        && PER_DEVICE_RESULT_TOOLS.has(ctx.tool)
        && intent.result?.truncated === true;
      const verdict: ToolResultClass = ctx.toolSource === 'tenant'
        ? RESULT_OK
        : truncatedPerDevice
          ? { kind: 'may_still_run', message: RESULT_TOO_LARGE_TEXT }
          : classifyToolResult(ctx.tool, intent.result);
      if (verdict.kind === 'may_still_run') {
        return {
          kind: 'end',
          step: {
            status: 'unknown_outcome',
            errorCode: 'unknown_outcome',
            error: verdict.message,
            approvedByUserId: intent.decidedByUserId,
            finishedAt,
          },
          run: { status: 'failed', errorCode: 'unknown_outcome', error: `Step ${ctx.stepId} may or may not have taken effect.` },
          unknownOutcome: true,
        };
      }
      if (verdict.kind === 'error' || verdict.kind === 'nothing_ran') {
        const message = verdict.kind === 'nothing_ran'
          ? verdict.message
          : `The approved step ran and reported an error: ${resultErrorText(intent.result)}`;
        const step: StepRowValues = {
          status: 'failed',
          errorCode: 'step_failed',
          error: message,
          approvedByUserId: intent.decidedByUserId,
          finishedAt,
        };
        return ctx.onFailure === 'continue'
          ? { kind: 'continue', status: 'failed', output: null, step }
          : { kind: 'end', step, run: { status: 'failed', errorCode: 'step_failed', error: `Step ${ctx.stepId}: ${message}` }, unknownOutcome: false };
      }
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
      // W5 (#5220, Decision 12): a released built-in answered with its own
      // step error (builtins/release.ts). Keep its code, and end the run on a
      // policy failure whatever onFailure says — as the runner would have.
      const builtinError = ctx.toolSource === 'builtin' ? builtinStepErrorOf(intent.result) : null;
      if (builtinError) {
        const step: StepRowValues = {
          status: 'failed', errorCode: builtinError.code, error: builtinError.message, approvedByUserId: intent.decidedByUserId, finishedAt,
        };
        return ctx.onFailure === 'continue' && !builtinError.policy
          ? { kind: 'continue', status: 'failed', output: null, step }
          : { kind: 'end', step, run: { status: 'failed', errorCode: builtinError.code, error: `Step ${ctx.stepId}: ${builtinError.message}` }, unknownOutcome: false };
      }
      const step: StepRowValues = {
        status: 'failed',
        errorCode: 'step_failed',
        error: intent.executedAt !== null
          ? `The approved step ran and failed (${intent.errorCode ?? 'unknown'}).`
          : `The approved step failed before it ran (${intent.errorCode ?? 'unknown'}).`,
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
 * What a parked row records when the run ends EARLY (a precondition — flag
 * off, delegator, drift, disable, cancel — fires before the parked step is
 * resolved) while its intent is already TERMINAL (review finding 3).
 *
 * An intent that executed, or may have, is recorded from its own resolution:
 * `completed` keeps its result and approver; a may-have-run failure is
 * `unknown_outcome` (and the run ends `unknown_outcome`, see
 * `closeOpenRows`); one that ran and failed keeps its failure. Null ⇒ the
 * intent never executed (still pending, rejected, expired, cancelled, failed
 * before it ran, or gone), and `closeOpenRows` writes the row `cancelled`.
 */
export interface ParkedEarlyEnd {
  rowId: string;
  values: StepRowValues;
  unknownOutcome: boolean;
}

export function parkedRowOnEarlyEnd(
  rowId: string,
  intent: ParkedIntentRow | null,
  resolution: ParkedResolution,
): ParkedEarlyEnd | null {
  if (!intent || resolution.kind === 'pending') return null;
  const unknownOutcome = resolution.kind === 'end' && resolution.unknownOutcome;
  const executed = intent.status === 'completed' || intent.executedAt !== null || unknownOutcome;
  return executed ? { rowId, values: resolution.step, unknownOutcome } : null;
}

/**
 * Step-row writes that close every OPEN row when a run ends before its next
 * step (preconditions: flag off, delegator, drift, disable, cancel). A parked
 * row is cancelled — unless `parked` says its intent executed (see
 * `parkedRowOnEarlyEnd`); a `running` row of a dead slice is `worker_lost`
 * (tier 1) or `unknown_outcome` (tier ≥ 2 — it may have taken effect).
 * `unknownStepIds` non-empty ⇒ the caller ends the run `unknown_outcome`,
 * outranking the precondition's own code, and notifies.
 */
export function closeOpenRows(
  rows: Iterable<FlowRunStepRow>,
  now: Date,
  parked: ParkedEarlyEnd | null = null,
): { updates: Array<{ id: string; values: StepRowValues }>; unknownStepIds: string[] } {
  const updates: Array<{ id: string; values: StepRowValues }> = [];
  const unknownStepIds: string[] = [];
  for (const row of rows) {
    if (row.status === 'awaiting_approval' && parked && parked.rowId === row.id) {
      updates.push({ id: row.id, values: { ...parked.values, finishedAt: parked.values.finishedAt ?? now } });
      if (parked.unknownOutcome) unknownStepIds.push(row.stepId);
    } else if (row.status === 'awaiting_approval') {
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
