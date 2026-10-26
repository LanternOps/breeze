/**
 * Tool catalog W04 (#5219), plan Task A5 / Decision 6 — the SERVER facts about
 * a flow run that its approval lifecycle depends on.
 *
 * The four-eyes exclusions (the publication's delegator and a manual run's
 * triggerer) decide who may approve unattended Tier-3 work, so they are always
 * read from the run and its pinned publication here — never taken from a
 * caller (createActionIntent's `flowRun` input is cross-checked against this,
 * and the decide path reads only this).
 *
 * System-scoped reads by id, each opened outside any ambient context (callers
 * include request paths whose org-scoped context would hide nothing here but
 * must not be borrowed for a cross-table read).
 */
import { and, eq } from 'drizzle-orm';
import type { FlowRunStatus } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flowRuns, flowRunSteps, flowVersions } from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';

export interface FlowIntentPeople {
  /** flow_versions.enabled_by_user_id of the run's publication (null once the user is deleted). */
  delegatorUserId: string | null;
  /** flow_runs.triggered_by_user_id (a manual run's human; null for schedule/event). */
  triggeredByUserId: string | null;
}

export interface FlowIntentRunFacts extends FlowIntentPeople {
  runId: string;
  orgId: string;
  flowId: string;
  flowName: string;
  status: FlowRunStatus;
  chainDepth: number;
  /** The step row the intent is minted for, when it belongs to this run. */
  step: { id: string; stepId: string; status: string } | null;
}

/** The run + publication + flow + (optionally) the step row an intent is about to be minted for. */
export async function loadFlowIntentRun(runId: string, stepRowId?: string): Promise<FlowIntentRunFacts | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        runId: flowRuns.id,
        orgId: flowRuns.orgId,
        flowId: flowRuns.flowId,
        status: flowRuns.status,
        chainDepth: flowRuns.chainDepth,
        triggeredByUserId: flowRuns.triggeredByUserId,
        delegatorUserId: flowVersions.enabledByUserId,
        flowName: flows.name,
      })
      .from(flowRuns)
      .innerJoin(flowVersions, and(eq(flowVersions.id, flowRuns.flowVersionId), eq(flowVersions.flowId, flowRuns.flowId)))
      .innerJoin(flows, eq(flows.id, flowRuns.flowId))
      .where(eq(flowRuns.id, runId))
      .limit(1);
    if (!row) return null;
    let step: FlowIntentRunFacts['step'] = null;
    if (stepRowId) {
      const [stepRow] = await db
        .select({ id: flowRunSteps.id, stepId: flowRunSteps.stepId, status: flowRunSteps.status })
        .from(flowRunSteps)
        .where(and(eq(flowRunSteps.id, stepRowId), eq(flowRunSteps.runId, runId)))
        .limit(1);
      step = stepRow ?? null;
    }
    return { ...row, step };
  }, 'flows.loadFlowIntentRun'));
}

/** Decide-time read: who may never be the second pair of eyes on this run's four-eyes step. */
export async function loadFlowIntentPeople(runId: string): Promise<FlowIntentPeople | null> {
  const facts = await loadFlowIntentRun(runId);
  return facts ? { delegatorUserId: facts.delegatorUserId, triggeredByUserId: facts.triggeredByUserId } : null;
}
