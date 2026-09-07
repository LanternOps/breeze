import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { scriptExecutions, scriptExecutionBatches } from '../db/schema';

/**
 * The ONE place a `script_executions` row is driven terminal by the server, and
 * the only place `script_execution_batches` counters are maintained.
 *
 * WHY THIS EXISTS (#5128 review round 2, item I). Before this, only
 * `reapStaleScriptExecutions` kept the batch counters. Three other paths also
 * terminalise an execution — `propagateTimedOutDeviceCommand` (delivery
 * expiry / execution timeout), `propagateCancelledDeviceCommand` (user cancel,
 * org move, decommission, claim-time ineligibility) and the reaper's own
 * `cancelled` branch — and none of them touched the batch. Once the execution
 * row is terminal the reaper's selector (`status IN ('pending','queued',
 * 'running')`) never revisits it, so `devicesCompleted + devicesFailed` could
 * never reach `devicesTargeted` and the batch stayed non-terminal FOREVER. It
 * is the same defect class `commandResultHandlers.ts` (~680) already documents.
 *
 * THE CAS IS THE DOUBLE-COUNT GUARD. The batch counter is incremented only when
 * this call is the one that actually flipped the execution row; a second path
 * arriving later matches zero rows and increments nothing. Never increment a
 * counter outside this function.
 */

/**
 * Anything that can run these statements: the ambient `db`, or a caller's open
 * transaction handle (the cancel-on-event sweeps and the heartbeat claim both
 * need the bookkeeping inside their own transaction).
 */
type ScriptTerminalExecutor = Pick<typeof db, 'update' | 'select'>;

/**
 * Terminal states an execution can be driven to from the server side.
 * `completed` is the only one that counts toward `devicesCompleted`; every
 * other outcome counts as a batch failure, exactly as the reaper has always
 * done (a stopped or expired device is not a success for the batch).
 */
export type ScriptExecutionTerminalOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled';

export async function finalizeScriptExecutionTerminal(params: {
  executionId: string;
  /** From the owning command's `payload.batchId`; absent for single-device runs. */
  batchId?: string | null;
  outcome: ScriptExecutionTerminalOutcome;
  errorMessage: string | null;
  completedAt: Date;
  executor?: ScriptTerminalExecutor;
}): Promise<{ terminalised: boolean }> {
  const { executionId, outcome, errorMessage, completedAt } = params;
  const executor: ScriptTerminalExecutor = params.executor ?? db;

  const updated = await executor
    .update(scriptExecutions)
    .set({ status: outcome, errorMessage, completedAt })
    .where(
      and(
        eq(scriptExecutions.id, executionId),
        // The double-count fence. Also the reason a row already terminalised by
        // an earlier propagation path is a no-op here rather than a second
        // increment.
        inArray(scriptExecutions.status, ['pending', 'queued', 'running']),
      ),
    )
    .returning({ id: scriptExecutions.id });

  if (updated.length === 0) return { terminalised: false };

  const batchId = params.batchId ?? null;
  if (batchId) {
    await applyBatchCounter(executor, batchId, outcome);
  }

  return { terminalised: true };
}

/** Reads a `batchId` out of an arbitrary command payload, or null. */
export function batchIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).batchId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Increment + completion check. Deliberately NOT wrapped in its own
 * transaction: callers that need atomicity (the cancel-on-event sweeps, the
 * heartbeat claim) already pass their own `executor`, and one that cannot open
 * a nested one would be handed a savepoint for no benefit. The increment is a
 * single atomic `x = x + 1`, the follow-up SELECT sees it, and the batch's
 * terminal UPDATE is idempotent — so two racing finalisers can at worst both
 * write the same terminal row, which the previous inline `db.transaction`
 * (READ COMMITTED, no row lock) also allowed.
 */
async function applyBatchCounter(
  executor: ScriptTerminalExecutor,
  batchId: string,
  outcome: ScriptExecutionTerminalOutcome,
): Promise<void> {
  // A recovered success must not be counted as a batch failure.
  await executor
    .update(scriptExecutionBatches)
    .set(
      outcome === 'completed'
        ? { devicesCompleted: sql`${scriptExecutionBatches.devicesCompleted} + 1` }
        : { devicesFailed: sql`${scriptExecutionBatches.devicesFailed} + 1` },
    )
    .where(eq(scriptExecutionBatches.id, batchId));

  const [batch] = await executor
    .select({
      devicesTargeted: scriptExecutionBatches.devicesTargeted,
      devicesCompleted: scriptExecutionBatches.devicesCompleted,
      devicesFailed: scriptExecutionBatches.devicesFailed,
    })
    .from(scriptExecutionBatches)
    .where(eq(scriptExecutionBatches.id, batchId));

  if (!batch) return;
  if (batch.devicesCompleted + batch.devicesFailed < batch.devicesTargeted) return;

  await executor
    .update(scriptExecutionBatches)
    .set({
      status: batch.devicesFailed > 0 ? 'failed' : 'completed',
      completedAt: new Date(),
    })
    .where(eq(scriptExecutionBatches.id, batchId));
}
