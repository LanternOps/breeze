/**
 * Tool catalog W04 (#5219), plan Task A5 — the SQL behind the flow-aware
 * dispatch claim (intentClaim.ts) and the flow release authority
 * (releaseAuthority.ts).
 *
 * Every function runs on the AMBIENT `db`: the claim calls them inside its one
 * system transaction, so the `FOR UPDATE` locks taken here are held until that
 * transaction commits. The branch logic lives in intentClaim.ts and is
 * unit-tested against these functions as a mocked boundary; the SQL itself is
 * proven on a real database (flowIntentApproval.integration.test.ts).
 */
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { FlowRunErrorCode, FlowRunStatus, FlowStatus, FlowStepErrorCode } from '@breeze/shared';
import { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { flowRuns, flowRunSteps, flowVersions } from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';
import { organizations } from '../../db/schema/orgs';
import { buildLoadTenantToolBindingStateQuery } from '../toolSources/resolver';

const TERMINAL_RUN_STATUSES: readonly FlowRunStatus[] = ['completed', 'failed', 'cancelled', 'expired'];

export interface ClaimIntentRow {
  id: string;
  orgId: string;
  status: string;
  /** `COALESCE(release_by, expires_at) > now()` on the DB clock. */
  releaseLive: boolean;
  requestingFlowRunId: string | null;
  actionName: string;
  arguments: Record<string, unknown>;
  approvalScope: string;
  toolSourceToolId: string | null;
  toolRevision: string | null;
  taskId: string | null;
}

export async function loadIntentForClaim(intentId: string, opts: { lock: boolean }): Promise<ClaimIntentRow | null> {
  const query = db
    .select({
      id: actionIntents.id,
      orgId: actionIntents.orgId,
      status: actionIntents.status,
      releaseLive: sql<boolean>`(COALESCE(${actionIntents.releaseBy}, ${actionIntents.expiresAt}) > now())`,
      requestingFlowRunId: actionIntents.requestingFlowRunId,
      actionName: actionIntents.actionName,
      arguments: actionIntents.arguments,
      approvalScope: actionIntents.approvalScope,
      toolSourceToolId: actionIntents.toolSourceToolId,
      toolRevision: actionIntents.toolRevision,
      taskId: actionIntents.taskId,
    })
    .from(actionIntents)
    .where(eq(actionIntents.id, intentId))
    .limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  return row ? { ...row, arguments: (row.arguments ?? {}) as Record<string, unknown> } : null;
}

export interface ClaimRunRow {
  id: string;
  orgId: string;
  flowId: string;
  flowVersionId: string;
  status: FlowRunStatus;
  /** A slice holds an unexpired lease right now (Decision 15). */
  leaseLive: boolean;
  cancelRequestedAt: Date | null;
  chainDepth: number;
}

export async function lockRunForClaim(runId: string, orgId: string): Promise<ClaimRunRow | null> {
  const [row] = await db
    .select({
      id: flowRuns.id,
      orgId: flowRuns.orgId,
      flowId: flowRuns.flowId,
      flowVersionId: flowRuns.flowVersionId,
      status: flowRuns.status,
      leaseLive: sql<boolean>`(${flowRuns.leaseToken} IS NOT NULL AND ${flowRuns.leaseExpiresAt} > now())`,
      cancelRequestedAt: flowRuns.cancelRequestedAt,
      chainDepth: flowRuns.chainDepth,
    })
    .from(flowRuns)
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.orgId, orgId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

export interface ClaimStepRow {
  id: string;
  stepId: string;
  status: string;
}

/** The (latest) step row of `runId` that parked on `intentId`. */
export async function lockStepForIntent(runId: string, intentId: string): Promise<ClaimStepRow | null> {
  const [row] = await db
    .select({ id: flowRunSteps.id, stepId: flowRunSteps.stepId, status: flowRunSteps.status })
    .from(flowRunSteps)
    .where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.actionIntentId, intentId)))
    .orderBy(desc(flowRunSteps.attempt))
    .limit(1)
    .for('update');
  return row ?? null;
}

export interface ClaimFlowRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  status: FlowStatus;
  enabledPublicationSeq: number | null;
}

/** A plain read — the flows row is NOT locked (disableFlow locks flows → runs → intents; see intentClaim.ts). */
export async function loadFlowForClaim(flowId: string): Promise<ClaimFlowRow | null> {
  const [row] = await db
    .select({
      id: flows.id,
      orgId: flows.orgId,
      partnerId: flows.partnerId,
      status: flows.status,
      enabledPublicationSeq: flows.enabledPublicationSeq,
    })
    .from(flows)
    .where(eq(flows.id, flowId))
    .limit(1);
  return row ?? null;
}

export interface ClaimPublicationRow {
  id: string;
  flowId: string;
  publicationSeq: number;
  enabledByUserId: string | null;
  stepPins: unknown;
}

export async function loadPublicationBySeq(flowId: string, publicationSeq: number): Promise<ClaimPublicationRow | null> {
  const [row] = await db
    .select({
      id: flowVersions.id,
      flowId: flowVersions.flowId,
      publicationSeq: flowVersions.publicationSeq,
      enabledByUserId: flowVersions.enabledByUserId,
      stepPins: flowVersions.stepPins,
    })
    .from(flowVersions)
    .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.publicationSeq, publicationSeq)))
    .limit(1);
  return row ?? null;
}

export async function loadOrgPartnerId(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.partnerId ?? null;
}

export interface ClaimTenantToolLive {
  revision: string;
  enabled: boolean;
  removedAt: Date | null;
  sourceStatus: string;
}

/** Unfiltered by-id read of the live tool row (classification only; release reloads it under the flow principal). */
export async function loadTenantToolLive(toolId: string): Promise<ClaimTenantToolLive | null> {
  const [row] = await buildLoadTenantToolBindingStateQuery(toolId);
  return row ? { revision: row.revision, enabled: row.enabled, removedAt: row.removedAt, sourceStatus: row.status } : null;
}

/** The claim itself: approved → executing, folded with the release lease (the 59:59 trap). */
export async function casIntentApprovedToExecuting(intentId: string): Promise<boolean> {
  const rows = await db
    .update(actionIntents)
    .set({ status: 'executing', executedAt: null, executionStartedAt: new Date() })
    .where(and(
      eq(actionIntents.id, intentId),
      eq(actionIntents.status, 'approved'),
      sql`COALESCE(${actionIntents.releaseBy}, ${actionIntents.expiresAt}) > now()`,
    ))
    .returning({ id: actionIntents.id });
  return rows.length > 0;
}

/** A refused claim: approved → cancelled. The caller publishes the terminal outbox (and so the run wake). */
export async function casIntentApprovedToCancelled(
  intentId: string,
  errorCode: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .update(actionIntents)
    .set({ status: 'cancelled', errorCode, result })
    .where(and(eq(actionIntents.id, intentId), eq(actionIntents.status, 'approved')))
    .returning({ id: actionIntents.id });
  return rows.length > 0;
}

export async function closeStepForRefusal(
  stepRowId: string,
  outcome: { status: 'failed' | 'cancelled'; errorCode: FlowStepErrorCode; error: string },
): Promise<void> {
  await db
    .update(flowRunSteps)
    .set({ status: outcome.status, errorCode: outcome.errorCode, error: outcome.error.slice(0, 2000), finishedAt: new Date() })
    .where(and(eq(flowRunSteps.id, stepRowId), inArray(flowRunSteps.status, ['running', 'awaiting_approval'])));
}

/**
 * Ends a run the claim refused. Respects every flow_runs CHECK: terminal ⇒
 * `finished_at`; `wake_at` NULL (not waiting); the lease pair cleared together
 * (a slice that somehow still holds it fails its next fenced checkpoint). A run
 * that is already terminal is never written (flow_runs_immutable_trg).
 */
export async function terminalizeRunForRefusal(
  runId: string,
  outcome: { status: 'failed' | 'cancelled'; errorCode: FlowRunErrorCode; error: string },
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(flowRuns)
    .set({
      status: outcome.status,
      errorCode: outcome.errorCode,
      error: outcome.error.slice(0, 2000),
      finishedAt: now,
      wakeAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(flowRuns.id, runId), notInArray(flowRuns.status, [...TERMINAL_RUN_STATUSES])))
    .returning({ id: flowRuns.id });
  return rows.length > 0;
}

export interface FlowRunOwnershipFacts {
  run: { id: string; orgId: string; flowId: string; chainDepth: number };
  flow: { id: string; orgId: string | null; partnerId: string | null; status: FlowStatus; name: string } | null;
  orgPartnerId: string | null;
}

/** What the release authority needs to rebuild the run's flow principal. */
export async function loadFlowRunOwnership(runId: string): Promise<FlowRunOwnershipFacts | null> {
  const [run] = await db
    .select({ id: flowRuns.id, orgId: flowRuns.orgId, flowId: flowRuns.flowId, chainDepth: flowRuns.chainDepth })
    .from(flowRuns)
    .where(eq(flowRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const [flow] = await db
    .select({ id: flows.id, orgId: flows.orgId, partnerId: flows.partnerId, status: flows.status, name: flows.name })
    .from(flows)
    .where(eq(flows.id, run.flowId))
    .limit(1);
  return { run, flow: flow ?? null, orgPartnerId: await loadOrgPartnerId(run.orgId) };
}
