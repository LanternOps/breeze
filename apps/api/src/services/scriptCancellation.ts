import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { scriptExecutions } from '../db/schema/scripts';
import { captureException } from './sentry';

/**
 * #3525 — the script cancellation state machine.
 *
 * `script_executions.status` describes what happened to the PROCESS.
 * `script_executions.cancel_state` describes what happened to the CANCEL
 * REQUEST. They are orthogonal (spec OD8-C), and the honesty contract is:
 *
 *   a row becomes `cancelled` ONLY when the stop was proven.
 *
 * Everything else reverts `status` to `cancel_prev_status` — the value it held
 * when the cancel was requested — and records why in `cancel_state`. Reverting
 * (rather than inventing a terminal `cancel_failed`) is what keeps the row
 * inside `reapStaleScriptExecutions`' `pending|queued|running` predicate, so a
 * failed cancel never strands an execution and that reaper stays untouched.
 *
 * W02 lands this closer (closer 2 of 5, the agent's `script_cancel` ack). The
 * request-side entry points (`cancelScriptExecution`, `cancelExecutionsForRun`)
 * and the remaining four closers land in the follow-on waves.
 */

/** Default SIGTERM→SIGKILL grace handed to the agent, in seconds (spec OD2-B). */
export const DEFAULT_GRACE_SECONDS = 5;
/**
 * Upper bound on a caller-supplied grace. Every downstream deadline must exceed
 * this — notably the agent's helper IPC timeout.
 */
export const MAX_GRACE_SECONDS = 30;
/**
 * How long a delivered cancel may stay unresolved before the sweep gives up on
 * it and records `unconfirmed`. Measured from DELIVERY, not from the request:
 * an undelivered cancel is the generic command reaper's problem, not this one's.
 */
export const CANCEL_GRACE_MS = Number(process.env.CANCEL_GRACE_MS ?? 90_000);

/** Statuses from which a cancel may be requested. */
export const CANCELLABLE_STATUSES = ['pending', 'queued', 'running'] as const;

/**
 * Clamp a caller-supplied grace into 0..MAX_GRACE_SECONDS, defaulting anything
 * absent or non-numeric. Exported so the request path and the AI tool cannot
 * drift from the value the agent is actually promised.
 */
export function clampGraceSeconds(seconds?: number | null): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return DEFAULT_GRACE_SECONDS;
  return Math.min(MAX_GRACE_SECONDS, Math.max(0, Math.floor(seconds)));
}

type CancelResolution =
  | { cancelState: 'confirmed'; proven: true }
  | { cancelState: 'unconfirmed' | 'failed'; proven: false };

/**
 * Pull the agent's structured cancellation outcome out of a command result.
 *
 * `tools.NewSuccessResult` marshals its payload into `CommandResult.Result`, so
 * the HTTP transport delivers `{ status, result: { outcome } }`; a top-level
 * `outcome` is accepted too so the shape is not load-bearing on one transport.
 */
function readOutcome(result: Record<string, unknown> | null): string {
  if (!result) return '';
  const top = result.outcome;
  if (typeof top === 'string') return top;
  const nested = result.result;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const inner = (nested as Record<string, unknown>).outcome;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

/**
 * Map an agent outcome onto the OD8-C state table.
 *
 * Only `terminated` is proof. In particular:
 *  - `not_found` is NOT confirmation. An agent that restarted has an empty
 *    running-process map, and on macOS/BSD there is no Pdeathsig, so an orphan
 *    may survive. Far more often it means "the script finished a moment ago and
 *    its result is in flight" — which must resolve to the REAL outcome.
 *  - a pre-#3525 agent replies `{cancelled: true}` with no outcome after a
 *    non-blocking signal, which is a request, not a receipt.
 *  - an agent too old to know the command answers "unknown command type".
 * All three are `unconfirmed`: degraded, but honest.
 */
export function resolveCancelAckOutcome(result: Record<string, unknown> | null): CancelResolution {
  switch (readOutcome(result)) {
    case 'terminated':
      return { cancelState: 'confirmed', proven: true };
    case 'kill_failed':
      return { cancelState: 'failed', proven: false };
    default:
      return { cancelState: 'unconfirmed', proven: false };
  }
}

/**
 * Closer 2 of 5. Applies the agent's `script_cancel` ack to the execution the
 * cancel command was issued for.
 *
 * No-ops when no `cancelling` execution matches: another closer (the original
 * script result, the cancel-command expiry, or the sweep) already resolved it,
 * and this one must not resurrect a decided row. Every write is compare-and-swap
 * guarded on `status = 'cancelling'` for the same reason.
 */
export async function applyScriptCancelAck(input: {
  cancelCommandId: string;
  result: Record<string, unknown> | null;
}): Promise<void> {
  const resolution = resolveCancelAckOutcome(input.result);

  // The ack arrives on the agent transport, which carries no tenant context.
  // runOutsideDbContext escapes any caller transaction so a slow close cannot
  // hold the transport's own work open.
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.transaction(async (tx) => {
      const [execution] = await tx
        .select({
          id: scriptExecutions.id,
          cancelPrevStatus: scriptExecutions.cancelPrevStatus,
        })
        .from(scriptExecutions)
        .where(and(
          eq(scriptExecutions.cancelCommandId, input.cancelCommandId),
          eq(scriptExecutions.status, 'cancelling'),
        ))
        .limit(1)
        .for('update');

      if (!execution) return;

      const guard = and(
        eq(scriptExecutions.id, execution.id),
        eq(scriptExecutions.status, 'cancelling'),
      );

      if (resolution.proven) {
        await tx.update(scriptExecutions).set({
          status: 'cancelled',
          cancelState: 'confirmed',
          completedAt: new Date(),
          errorMessage: 'Stopped on the device',
        }).where(guard);
        return;
      }

      // REVERT. A failed cancel request does not change what happened to the
      // process. `cancel_prev_status` is written alongside the cancel, so a NULL
      // here is a broken writer, not a race — report it rather than let the
      // safety net hide a bug that could be misreporting execution history
      // fleet-wide. `running` is the safe floor because it keeps the execution
      // inside the stale-execution reaper's predicate rather than stranding it
      // in `cancelling` forever, so the revert itself still goes ahead.
      if (execution.cancelPrevStatus === null) {
        const err = new Error(
          'script_executions.cancel_prev_status was NULL on a cancelling row; reverting to running',
        );
        console.error('[scriptCancellation]', err.message, {
          executionId: execution.id,
          cancelCommandId: input.cancelCommandId,
        });
        captureException(err, undefined, {
          executionId: execution.id,
          cancelCommandId: input.cancelCommandId,
        });
      }
      await tx.update(scriptExecutions).set({
        status: execution.cancelPrevStatus ?? 'running',
        cancelState: resolution.cancelState,
      }).where(guard);
    });
  }));
}
