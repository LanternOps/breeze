import { and, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import { automationActionResults, automationRuns } from '../db/schema';
import { reconcileAutomationRun } from './automationActionResults';
import { captureException } from './sentry';
import type { RunCancelTally } from './scriptCancellation';

// `scriptCancellation` reaches agentWs → commandQueue → configurationPolicy at
// module load. Importing it eagerly here would drag that chain into every
// partial-mock unit suite that imports the automation runtime (which imports
// this module for the fence), so the VALUE import is deferred to the one
// function that needs it — the same lazy-import pattern automationRuntime.ts
// already uses for softwareDeployment.
const loadRunSweep = () => import('./scriptCancellation');

/**
 * #3525 W05 — stopping a whole automation run.
 *
 * Authorization-free by design, exactly like `scriptCancellation.ts`: the route
 * owns the org / partner-wide / site / MFA gates, this owns the state machine,
 * so the route, a future AI tool and any worker cannot drift apart.
 *
 * ## The fence, and what it actually guarantees
 *
 * `cancelAutomationRun` marks the run `cancelled` while holding `FOR UPDATE`
 * on its row. Every dispatch-side entry point calls `assertRunNotCancelled`,
 * which reads that row `FOR SHARE`, so:
 *
 *  - a dispatcher that acquires `FOR SHARE` first blocks the cancel until it
 *    commits, which means whatever it created is visible to the fan-out below;
 *  - a dispatcher that arrives after the cancel committed sees `cancelled` and
 *    throws `RunCancelledError` before dispatching anything.
 *
 * The lock is deliberately NOT held across the dispatch itself. Doing that
 * would pin a pooled connection across a device command insert and a WebSocket
 * send for five concurrent devices at a time — the double-hold that CLAUDE.md
 * calls out, and a self-deadlock once the pool is exhausted. The residual
 * window (an execution row committed microseconds after the fan-out's read) is
 * closed on the dispatch side instead: `automationRuntime` re-checks the run
 * after recording a dispatch and cancels the execution it just created. So an
 * execution belonging to a cancelled run is either caught by the sweep here or
 * cancelled by its own dispatcher — never left running.
 */

/** Thrown by `assertRunNotCancelled`; callers treat it as "stop, quietly". */
export class RunCancelledError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Automation run ${runId} was cancelled`);
    this.name = 'RunCancelledError';
    this.runId = runId;
  }
}

export function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError
    || (error instanceof Error && error.name === 'RunCancelledError');
}

/**
 * Anything that can run raw SQL — the module `db`, or a transaction handle.
 * Typed structurally so a caller inside `db.transaction` takes the row lock in
 * ITS transaction rather than a second, independent one.
 */
export type RunFenceExecutor = { execute: (query: SQL) => Promise<unknown> };

/**
 * The dispatch fence. `FOR SHARE` (not `FOR UPDATE`): concurrent dispatchers
 * must not serialise against each other, only against the cancel.
 *
 * A run that no longer exists is NOT an error here — the caller's own
 * existence checks own that, and turning a deleted run into a throw would turn
 * a benign race into a failed BullMQ job.
 */
export async function assertRunNotCancelled(
  executor: RunFenceExecutor,
  runId: string,
): Promise<void> {
  const rows = await executor.execute(sql`
    SELECT status
    FROM automation_runs
    WHERE id = ${runId}::uuid
    FOR SHARE
  `) as unknown as Array<{ status: string }>;
  if (rows[0]?.status === 'cancelled') throw new RunCancelledError(runId);
}

/**
 * Action types a run-wide cancel cannot stop, and why. Both are reported to
 * the caller rather than silently folded into "cancelled", because claiming a
 * run stopped while one of these is still live is the dishonesty the whole
 * cancellation design exists to prevent.
 */
const UNCANCELLABLE_ACTION_REASONS: Record<string, string> = {
  // executeCommandAction dispatches a device command and deliberately creates
  // no script_executions row, so there is nothing for the fan-out to key on.
  execute_command: 'Ad-hoc commands have no script execution to stop; the command runs to completion on the device.',
  // Deployments are tracked in deployment_results, which the agent has no
  // stop verb for.
  deploy_software: 'Software deployments cannot be recalled once dispatched; the install runs to completion on the device.',
};
const UNCANCELLABLE_ACTION_TYPES = Object.keys(UNCANCELLABLE_ACTION_REASONS);

/** Action-result statuses that mean the row is closed and needs no cancel. */
const TERMINAL_ACTION_STATUSES = ['succeeded', 'failed', 'skipped', 'timed_out', 'cancelled'] as const;

export type UncancellableAction = {
  actionIndex: number;
  actionType: string;
  reason: string;
};

export type CancelAutomationRunOutcome =
  /** No such run — a race with a delete, or a bad id. */
  | { kind: 'not_found' }
  /** The run already finished on its own; relabelling it would be a lie. */
  | { kind: 'already_terminal'; status: 'completed' | 'failed' | 'partial' }
  | {
      kind: 'cancelled';
      /** True when the run was ALREADY cancelled; the sweep still re-ran. */
      alreadyCancelling: boolean;
      /** Action rows that had not been dispatched and are now terminal. */
      actionsCancelled: number;
      /** Executions this call asked to stop (`requested`) or proved stopped
       *  (`retracted`). Deliberately excludes `alreadyCancelling`, which had
       *  been asked by an earlier call and has NOT stopped. */
      executionsCancelled: number;
      /** Full per-kind breakdown, so a caller can report honestly. */
      executions: RunCancelTally;
      uncancellableActions: UncancellableAction[];
    };

function inDeliberateSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * The still-live actions this cancel cannot reach. Collected AFTER the
 * never-dispatched rows have been terminalised, so an `execute_command` that
 * was still `pending` (and therefore genuinely cancelled) is not reported.
 */
async function collectUncancellableActions(runId: string): Promise<UncancellableAction[]> {
  const rows = await db
    .select({
      actionIndex: automationActionResults.actionIndex,
      actionType: automationActionResults.actionType,
    })
    .from(automationActionResults)
    .where(and(
      eq(automationActionResults.runId, runId),
      inArray(automationActionResults.actionType, UNCANCELLABLE_ACTION_TYPES),
      notInArray(automationActionResults.status, [...TERMINAL_ACTION_STATUSES]),
    ));

  const byIndex = new Map<number, UncancellableAction>();
  for (const row of rows) {
    if (byIndex.has(row.actionIndex)) continue;
    byIndex.set(row.actionIndex, {
      actionIndex: row.actionIndex,
      actionType: row.actionType,
      reason: UNCANCELLABLE_ACTION_REASONS[row.actionType]
        ?? 'This action type cannot be stopped once dispatched.',
    });
  }
  return [...byIndex.values()].sort((a, b) => a.actionIndex - b.actionIndex);
}

/**
 * Stop one automation run.
 *
 * Order matters and is load-bearing:
 *  1. inside ONE transaction, under `FOR UPDATE`: flip the run to `cancelled`
 *     (this write IS the fence) and terminalise every action row that was
 *     never dispatched;
 *  2. after that transaction commits: sweep the run's still-live script
 *     executions. `cancelExecutionsForRun` opens a transaction per execution
 *     and delivers each `script_cancel` to the agent AFTER its own commit, so
 *     running it inside step 1 would both hold the run lock across N network
 *     sends and let a fast agent ack race a row that is not yet visible;
 *  3. reconcile, so the rows terminalised in step 1 roll up into their device
 *     rows and `devices_cancelled`.
 */
export async function cancelAutomationRun(input: {
  runId: string;
  actorId: string | null;
  actorLabel: string;
  graceSeconds?: number | null;
}): Promise<CancelAutomationRunOutcome> {
  const { runId } = input;

  const fence = await inDeliberateSystemContext(() => db.transaction(async (tx) => {
    const [run] = await tx
      .select({ id: automationRuns.id, status: automationRuns.status })
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .limit(1)
      .for('update');
    if (!run) return { kind: 'not_found' } as const;

    if (run.status !== 'running' && run.status !== 'cancelled') {
      return { kind: 'already_terminal', status: run.status } as const;
    }

    if (run.status === 'cancelled') {
      // Idempotent. The status write and the never-dispatched sweep already
      // happened; only the fan-out is worth repeating, because devices that
      // did not stop the first time should be asked again.
      return { kind: 'cancelled', alreadyCancelling: true, actionsCancelled: 0 } as const;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'warning',
      message: `Run cancelled by ${input.actorLabel}`,
    };
    await tx
      .update(automationRuns)
      .set({
        status: 'cancelled',
        // Both runners write the WHOLE logs array they loaded at run start
        // (`set({ logs })`), so a plain assignment here would be erased by the
        // next dispatch-phase write. Appending in SQL survives that.
        logs: sql`COALESCE(${automationRuns.logs}, '[]'::jsonb) || ${JSON.stringify([logEntry])}::jsonb`,
      })
      .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'running')));

    // ONLY `pending`. An action that is queued/delivered/running has already
    // reached the device; it closes when its own child closes, and pretending
    // otherwise here is exactly the "claimed stopped" lie the honesty contract
    // forbids. This resolves the spec's own contradiction.
    const cancelledActions = await tx
      .update(automationActionResults)
      .set({
        status: 'cancelled',
        terminalSource: 'cancellation',
        message: 'Cancelled before dispatch',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(automationActionResults.runId, runId),
        eq(automationActionResults.status, 'pending'),
      ))
      .returning({ id: automationActionResults.id });

    return {
      kind: 'cancelled',
      alreadyCancelling: false,
      actionsCancelled: cancelledActions.length,
    } as const;
  }));

  if (fence.kind !== 'cancelled') return fence;

  // POST-COMMIT (see the ordering note above).
  const { cancelExecutionsForRun } = await loadRunSweep();
  const executions = await cancelExecutionsForRun({
    runId,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    graceSeconds: input.graceSeconds,
  });

  const uncancellableActions = await inDeliberateSystemContext(
    () => collectUncancellableActions(runId),
  );

  // Without this a run whose every action was still `pending` would sit at
  // devices_cancelled 0 and its device rows at `pending` until some unrelated
  // result happened to arrive.
  //
  // Best-effort ON PURPOSE. Everything that makes the stop real — the fence
  // write, the terminalised action rows, the queued script_cancel commands —
  // is already committed by here. Rethrowing would turn a cancel that
  // SUCCEEDED into a 500, telling the operator their stop failed and inviting
  // a retry, when all that actually failed is the roll-up of the counters.
  // Reconciliation is idempotent and re-runs on the next child result.
  try {
    await reconcileAutomationRun(runId);
  } catch (err) {
    console.error('[automationRunCancellation] reconcile after cancel failed; the cancel itself is committed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, undefined, { runId });
  }

  return {
    kind: 'cancelled',
    alreadyCancelling: fence.alreadyCancelling,
    actionsCancelled: fence.actionsCancelled,
    executionsCancelled: executions.requested + executions.retracted,
    executions,
    uncancellableActions,
  };
}
