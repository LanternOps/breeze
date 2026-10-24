import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runAfterDbContextExit } from '../db';
import { deploymentResults, deviceCommands, deviceFilesystemCleanupRuns } from '../db/schema';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
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
 * W3 added the `patch_job_results` branch. Anything without a branch is a no-op
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
type DbExecutor = Pick<typeof db, 'update' | 'select' | 'insert' | 'transaction'>;

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

/**
 * The ONE way a bulk path (tenant offboarding, abuse suspension, device
 * uninstall drain, ...) flips device commands to `cancelled` (#9719): performs
 * the UPDATE, then runs the per-command-type hook for every row it actually
 * flipped. A bare `UPDATE ... SET status='cancelled'` strands the owning
 * script execution / patch job / deployment result / incident action `pending`
 * forever, because the reaper never revisits a terminal command.
 *
 * `where` must already scope to the rows to cancel, including a non-terminal
 * status guard. The rows are read first (FOR UPDATE) and the UPDATE is bounded
 * to that read set, so a row that appears in between is left for the next
 * sweep rather than flipped without its payload; only rows the UPDATE returns
 * get hooks (a row that lost a race to a concurrent claim is not ours).
 *
 * Failure semantics (`isolateFailures`):
 *  - `false` (default inside a caller transaction): a hook failure propagates
 *    and rolls the cancel back, atomic with the caller (single user cancel,
 *    device restore).
 *  - `true` (security-critical or bulk callers, and the default on a bare pool
 *    with no executor and no DB access context): each hook runs in its own
 *    savepoint / transaction, so a failing hook is rolled back alone, logged
 *    with its command id and sent to Sentry, and neither the remaining hooks
 *    nor the caller's other writes (e.g. an abuse suspension's user disable and
 *    session revocation) are affected. The owner of a failed hook stays
 *    unterminalised; that is surfaced via the log + Sentry, not swallowed.
 */
export async function cancelDeviceCommands(params: {
  where: SQL;
  result: Record<string, unknown>;
  completedAt?: Date;
  executor?: DbExecutor;
  isolateFailures?: boolean;
  /** Override the per-command hook (tests). */
  propagate?: typeof propagateCancelledDeviceCommand;
}): Promise<DeviceCommandCancelSubject[]> {
  const executor: DbExecutor = params.executor ?? db;
  const completedAt = params.completedAt ?? new Date();
  const propagate = params.propagate ?? propagateCancelledDeviceCommand;
  // `db` is an ALS proxy: with a DB access context active it IS the request /
  // system transaction, so "bare pool" means no executor AND no context.
  const isolateFailures =
    params.isolateFailures ??
    (params.executor === undefined && getCurrentDbAccessContext() === undefined);

  // Read type + payload BEFORE the UPDATE: `terminalPayloadErasureSet()` nulls
  // the payload, `returning()` reflects post-update values, and the hooks key on
  // `payload.executionId` / `batchId` / `runId`.
  const before = await executor
    .select({ id: deviceCommands.id, type: deviceCommands.type, payload: deviceCommands.payload })
    .from(deviceCommands)
    .where(params.where)
    .for('update');
  if (before.length === 0) return [];
  const beforeById = new Map(before.map((row) => [row.id, row]));

  const flipped = await executor
    .update(deviceCommands)
    .set({
      status: 'cancelled',
      completedAt,
      result: params.result,
      ...terminalPayloadErasureSet(),
    })
    .where(and(params.where, inArray(deviceCommands.id, [...beforeById.keys()]))!)
    .returning({ id: deviceCommands.id, type: deviceCommands.type });

  const subjects: DeviceCommandCancelSubject[] = flipped.map((row) => {
    const payload = beforeById.get(row.id)?.payload;
    return {
      id: row.id,
      type: row.type,
      payload:
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null,
    };
  });

  for (const subject of subjects) {
    const run = (hookExecutor: DbExecutor) =>
      propagate({
        commandId: subject.id,
        type: subject.type,
        payload: subject.payload,
        completedAt,
        executor: hookExecutor,
      });
    if (!isolateFailures) {
      await run(executor);
      continue;
    }
    try {
      // Own savepoint (nested) / transaction (pool): a failed statement inside
      // the hook aborts only that unit, never the caller's transaction.
      await executor.transaction(async (hookTx) => run(hookTx as unknown as DbExecutor));
    } catch (err) {
      console.error('[commandCancelPropagation] cancelDeviceCommands: hook failed for a cancelled command', {
        commandId: subject.id,
        type: subject.type,
        error: err instanceof Error ? err.message : String(err),
      });
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        source: 'cancelDeviceCommands',
        commandType: subject.type,
        commandId: subject.id,
      });
    }
  }
  return subjects;
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

  // #5128 W3 — patch installs. A cancelled install must release the device from
  // the job's counters, or `devices_pending` / `devices_queued` never reach zero
  // and the job stays `running` forever.
  //
  // The import is DYNAMIC on purpose: `commandClaimEligibility` calls this module
  // from inside the heartbeat claim transaction, and `patchJobFinalizer`
  // registers its claim-time hold WITH `commandClaimEligibility` — a static edge
  // here would close that into an import cycle whose `typeHolds` const is still
  // in its temporal dead zone when the hold registers.
  if (type === 'install_patches') {
    const { finalizePatchDeviceForCommand } = await import('./patchJobFinalizer');
    // NOT wrapped in a try/catch, exactly like the `script` branch above.
    // `executor` is frequently the CALLER'S OPEN TRANSACTION (the heartbeat
    // claim, the org-move and decommission sweeps): swallowing a failure here
    // would let that transaction commit a cancelled command alongside a
    // half-written patch result and unmoved counters, stranding the job
    // `running` forever with one Sentry event as the only trace. Letting it
    // propagate rolls the whole cancel back so it can be retried.
    await finalizePatchDeviceForCommand({
      commandId,
      payload,
      terminal: { kind: 'cancelled', reason: 'cancelled' },
      completedAt,
      executor,
    });
  }

  // Disk Cleanup v2 (spec §13 #13). A cancelled native cleanup command leaves
  // its `device_filesystem_cleanup_runs` row `running` — on a device that has
  // just moved org or been decommissioned, nothing will ever revisit it: the
  // poll route that applies the lazy deadline is no longer reachable from the
  // tech who started the run, and the reaper terminalises COMMANDS, not this
  // row.
  //
  // In the caller's transaction (the org flip, the decommission write) for the
  // same reason every branch above is: a rollback must not leave a cancelled
  // command beside a run row that still claims to be executing.
  //
  // CAS on `running` so a real result that landed first keeps its outcome.
  if (type === 'system_cleanup_run') {
    const runId =
      payload && typeof payload.runId === 'string' && payload.runId.trim().length > 0
        ? payload.runId
        : null;
    if (runId) {
      await executor
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'failed', error: errorMessage, updatedAt: completedAt })
        .where(
          and(
            eq(deviceFilesystemCleanupRuns.id, runId),
            eq(deviceFilesystemCleanupRuns.status, 'running'),
          ),
        );
    }
  }

  // Disk Cleanup v2 W03 (spec §13 #13). A cleanup `file_delete` carries the id
  // of the run that dispatched it (routes/devices/filesystem.ts). Cancelling
  // the command without terminalising that run leaves it `running` until the
  // 24-hour retention sweep, which is the same "waiting forever on a delivery
  // that will never happen" this module exists to prevent.
  //
  // DYNAMIC import for the same reason as the patch branch above: keeping this
  // module a leaf. An ordinary File Manager delete carries no `cleanupRunId`
  // and falls through untouched.
  if (type === 'file_delete') {
    const cleanupRunId =
      payload && typeof payload.cleanupRunId === 'string' && payload.cleanupRunId.length > 0
        ? payload.cleanupRunId
        : null;
    if (cleanupRunId) {
      const { cancelCleanupRunForCommand } = await import('./filesystemCleanupRuns');
      // Not try/caught, exactly like the two branches above: `executor` is
      // frequently the caller's open transaction (the org-move flip), and
      // swallowing a failure here would commit a cancelled command alongside a
      // run still claiming to be `running`.
      await cancelCleanupRunForCommand({
        cleanupRunId,
        reason: errorMessage,
        completedAt,
        executor,
      });
    }
  }

  // #9662 — a cancelled execute_containment leaves its incident action
  // `in_progress` forever otherwise. DYNAMIC import, like the branches above,
  // to keep this module a leaf. Not try/caught, for the same reason: a
  // failure rolls the caller's cancel back with it.
  if (type === 'execute_containment') {
    const { finalizeContainmentAction } = await import('./incidentContainmentResults');
    await finalizeContainmentAction({
      commandId,
      payload,
      outcome: { kind: 'cancelled', error: errorMessage },
      completedAt,
      executor,
    });
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
  // like the batch counters it is only ever advanced by a terminal event. It
  // runs in its own system context (`inDeliberateSystemContext`), so it
  // deliberately does not join the caller's transaction — and its failure must
  // never abort a cancel that has already committed the important writes.
  //
  // From inside a tenant-scoped transaction (the heartbeat claim, a user
  // cancel) that system context is a SECOND pooled connection opened while the
  // caller still holds its first; under concurrent heartbeats that deadlocks
  // the pool (#1105). So there it waits until the caller's transaction has
  // settled. A system-scoped caller joins its own transaction inline, as before.
  const terminaliseAutomationAction = async () => {
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
  };
  const scope = getCurrentDbAccessContext()?.scope;
  if (scope !== undefined && scope !== 'system') {
    runAfterDbContextExit('commandCancelPropagation.automationActionTerminal', terminaliseAutomationAction);
    return;
  }
  await terminaliseAutomationAction();
}
