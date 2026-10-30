/**
 * Tool Catalog W05 (#5220), plan Task B2 — the reads the release worker's
 * flow branch needs to execute an approved Tier-3 built-in: the run, its
 * publication and the publication's definition of the parked step. System
 * context with explicit predicates (a background job; the dispatch claim has
 * already proved, under lock, that the run is parked on this intent and that
 * its publication is the flow's live one).
 */
import { and, eq } from 'drizzle-orm';
import { flowDocumentV1Schema, type FlowDocumentV1 } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { flowRuns, flowRunSteps, flowVersions } from '../../../db/schema';
import type { FlowRunRow, FlowVersionRow } from '../../../db/schema/flowRuns';

export interface ReleasedBuiltinStep {
  run: FlowRunRow;
  version: FlowVersionRow;
  /** The publication's definition of the parked step. */
  step: FlowDocumentV1['steps'][number];
  stepRowId: string;
  /** The parked step row's for-each item index (null outside a for-each). */
  itemIndex: number | null;
}

/** Null when the run, its publication, the parked step row or its definition is gone or unreadable. */
export async function loadReleasedBuiltinStep(runId: string, intentId: string): Promise<ReleasedBuiltinStep | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [run] = await db.select().from(flowRuns).where(eq(flowRuns.id, runId)).limit(1);
    if (!run) return null;
    const [version] = await db
      .select()
      .from(flowVersions)
      .where(and(eq(flowVersions.id, run.flowVersionId), eq(flowVersions.flowId, run.flowId)))
      .limit(1);
    if (!version) return null;
    const [row] = await db
      .select({ id: flowRunSteps.id, stepId: flowRunSteps.stepId, itemIndex: flowRunSteps.itemIndex })
      .from(flowRunSteps)
      .where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.actionIntentId, intentId)))
      .limit(1);
    if (!row) return null;
    const doc = flowDocumentV1Schema.safeParse(version.definition);
    if (!doc.success) return null;
    const step = doc.data.steps.find((s) => s.id === row.stepId);
    return step ? { run, version, step, stepRowId: row.id, itemIndex: row.itemIndex } : null;
  }, 'flows.builtins.loadReleasedBuiltinStep'));
}
