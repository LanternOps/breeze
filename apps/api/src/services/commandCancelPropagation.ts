import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { deploymentResults } from '../db/schema';
import { applyAutomationActionTerminal } from './automationActionResults';
import { captureException } from './sentry';
import { batchIdFromPayload, finalizeScriptExecutionTerminal } from './scriptExecutionTerminal';

/**
 * Terminalise the higher-level records owned by a device command that was
 * CANCELLED (#5128 §G) — by a user, by a cancel-on-event sweep (org move,
 * decommission), or by claim-time eligibility. Sibling of
 * `propagateTimedOutDeviceCommand`: the command row itself is already terminal
 * by the time this runs; this only stops the owning record from waiting forever
 * on a delivery that will never happen.
 *
 * W3 adds the `patch_job_results` branch. Anything without a branch is a no-op
 * by design — a generic command has no higher-level record (#5128 §F).
 *
 * Deliberately a LEAF module: `services/commandClaimEligibility.ts` has to call
 * this from inside the heartbeat claim transaction, and it is itself reachable
 * from `commandQueue` → `dispatchDeviceCommand` → `commandDispatch`. Leaving
 * these functions in `jobs/staleCommandReaper.ts` (which imports
 * `services/commandQueue`) would close that loop into an import cycle, so they
 * live here and the reaper re-exports them for its existing importers.
 */

/**
 * Anything that can run the propagation UPDATEs: the ambient `db`, or a caller's
 * open transaction handle.
 */
type DbExecutor = Pick<typeof db, 'update' | 'select'>;

export type DeviceCommandCancelSubject = {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
};

/**
 * Bulk sibling of `propagateCancelledDeviceCommand` for the cancel-on-event
 * paths (org move, decommission), which cancel every pending row for a device
 * in one UPDATE. Takes the caller's transaction so the owning records are
 * terminalised atomically with the cancel itself.
 */
export async function propagateCancelledDeviceCommands(
  rows: readonly DeviceCommandCancelSubject[],
  completedAt: Date,
  executor: DbExecutor = db,
): Promise<void> {
  for (const row of rows) {
    await propagateCancelledDeviceCommand({
      commandId: row.id,
      type: row.type,
      payload: row.payload,
      completedAt,
      executor,
    });
  }
}

export async function propagateCancelledDeviceCommand(params: {
  commandId: string;
  type: string;
  payload: Record<string, unknown> | null;
  completedAt: Date;
  cancelledBy?: string | null;
  /**
   * #5128: the cancel-on-event callers run inside their own transaction (the
   * org flip / the decommission write) and must terminalise the owning records
   * in that SAME transaction, or a rollback would leave a cancelled command
   * with a `script_executions` / `deployment_results` row still `pending`.
   */
  executor?: DbExecutor;
}): Promise<void> {
  const { commandId, type, payload, completedAt } = params;
  const executor: DbExecutor = params.executor ?? db;
  const errorMessage = 'Cancelled before the device received it';

  if (type === 'script') {
    const executionId =
      payload && typeof payload.executionId === 'string' && payload.executionId.trim().length > 0
        ? payload.executionId
        : null;
    if (executionId) {
      // Goes through the shared terminaliser, so the owning
      // `script_execution_batches` counters advance too. Terminalising the
      // execution without them left the batch non-terminal forever: the
      // execution reaper's selector never revisits a terminal row, so
      // `devicesCompleted + devicesFailed` could never reach `devicesTargeted`.
      await finalizeScriptExecutionTerminal({
        executionId,
        batchId: batchIdFromPayload(payload),
        outcome: 'cancelled',
        errorMessage,
        completedAt,
        executor,
      });
    }
  }

  await executor
    .update(deploymentResults)
    .set({ status: 'cancelled', errorMessage, completedAt })
    .where(
      and(
        eq(deploymentResults.deviceCommandId, commandId),
        eq(deploymentResults.status, 'pending'),
      ),
    );

  // An automation action that dispatched this command is waiting on it too, and
  // like the batch counters it is only ever advanced by a terminal event. Runs
  // on its OWN connection (`inDeliberateSystemContext`), so it deliberately does
  // not join the caller's transaction — and its failure must never abort a
  // cancel that has already committed the important writes.
  try {
    await applyAutomationActionTerminal({
      source: 'cancellation',
      commandId,
      terminalStatus: 'cancelled',
      error: errorMessage,
      completedAt,
    });
  } catch (err) {
    console.error(
      '[commandCancelPropagation] failed to terminalise the automation action for a cancelled command',
      { commandId, type, error: err instanceof Error ? err.message : String(err) },
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
