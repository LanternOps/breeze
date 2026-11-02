/**
 * Tool Catalog W06 (#5221) — the device sets an earlier fleet step of the SAME
 * run recorded (`fromStep` selectors). Read from the step's own ledger row (its
 * newest attempt, item_index NULL), not from the rendered scope, so a selector
 * is never a template the run could steer. System context with explicit run
 * and step predicates (the caller passes its own run id); the ids are re-read
 * in the run org before anything uses them.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { flowRunSteps } from '../../../db/schema';

export interface FleetStepSets {
  dispatchedDeviceIds: string[];
  succeededDeviceIds: string[];
  failedDeviceIds: string[];
}

function idList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

/** Null when the step has no recorded fleet output (not run, not a fleet step, or pruned). */
export async function loadFleetStepOutput(runId: string, stepId: string): Promise<FleetStepSets | null> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db
      .select({ output: flowRunSteps.output, status: flowRunSteps.status, tool: flowRunSteps.tool })
      .from(flowRunSteps)
      .where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.stepId, stepId), isNull(flowRunSteps.itemIndex)))
      .orderBy(desc(flowRunSteps.attempt))
      .limit(1),
    'flows.builtins.loadFleetStepOutput',
  ));
  if (!row || (row.tool !== 'resolve_targets' && row.tool !== 'run_script_on_targets')) return null;
  if (row.status !== 'completed' && row.status !== 'failed') return null;
  const o = row.output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const dispatched = idList(o.dispatchedDeviceIds);
  const succeeded = idList(o.succeededDeviceIds);
  const failed = idList(o.failedDeviceIds);
  if (!dispatched || !succeeded || !failed) return null;
  return { dispatchedDeviceIds: dispatched, succeededDeviceIds: succeeded, failedDeviceIds: failed };
}

/**
 * #10705 — why each of `deviceIds` failed on a `run_script_on_targets` step of
 * this run: the error its per-device claim row recorded (the row the dispatch
 * wrote in the same transaction — `scriptFleetDispatch.ts`). A device with no
 * row (refused before dispatch) or no recorded error is absent from the map.
 */
export async function loadFleetDeviceFailureReasons(
  runId: string,
  stepId: string,
  deviceIds: readonly string[],
): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  if (deviceIds.length === 0) return reasons;
  const deviceIdOf = sql<string>`${flowRunSteps.renderedInput}->>'deviceId'`;
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db
      .select({ deviceId: deviceIdOf, error: flowRunSteps.error, outputError: sql<string | null>`${flowRunSteps.output}->>'error'` })
      .from(flowRunSteps)
      .where(and(
        eq(flowRunSteps.runId, runId),
        eq(flowRunSteps.stepId, stepId),
        eq(flowRunSteps.tool, 'run_script_on_targets'),
        isNotNull(flowRunSteps.itemIndex),
        // Device claim rows are written once, at attempt 1 (findDeviceStepRow).
        eq(flowRunSteps.attempt, 1),
        inArray(deviceIdOf, [...deviceIds]),
      )),
    'flows.builtins.loadFleetDeviceFailureReasons',
  ));
  for (const row of rows) {
    const reason = row.error || row.outputError;
    if (row.deviceId && reason) reasons.set(row.deviceId, reason);
  }
  return reasons;
}
