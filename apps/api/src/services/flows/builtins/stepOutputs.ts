/**
 * Tool Catalog W06 (#5221) — the device sets an earlier fleet step of the SAME
 * run recorded (`fromStep` selectors). Read from the step's own ledger row (its
 * newest attempt, item_index NULL), not from the rendered scope, so a selector
 * is never a template the run could steer. System context with explicit run
 * and step predicates (the caller passes its own run id); the ids are re-read
 * in the run org before anything uses them.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
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
