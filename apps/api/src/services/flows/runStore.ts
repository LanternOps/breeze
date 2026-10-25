/**
 * Tool catalog W04 (#5219), plan Task A8 — the SQL behind the flow runner
 * (runSlice.ts), the run lease (runLease.ts) and run admission
 * (runAdmission.ts).
 *
 * Every function is ONE statement on the AMBIENT `db`; the callers open the
 * system transaction (runLease.checkpoint, runAdmission.claimRunSlot) or a
 * fresh short one per read (runSlice). The branch logic lives in those
 * modules and is unit-tested against this file as a mocked boundary (the
 * intentClaimStore.ts precedent); the predicates themselves — the lease
 * token fence, the terminal guard, `now()` on the DB clock — are proven on a
 * real database (flowRunLease.integration.test.ts).
 *
 * Explicit predicates everywhere: the runner is a background job in SYSTEM
 * scope, so RLS admits every row and the WHERE clause is the only fence.
 */
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { FLOW_RUN_LIMITS, type FlowRunStatus } from '@breeze/shared';
import { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import {
  flowRuns,
  flowRunSteps,
  flowVersions,
  type FlowRunRow,
  type FlowRunStepRow,
  type FlowVersionRow,
  type NewFlowRunStepRow,
} from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';
import { organizations } from '../../db/schema/orgs';
import type { ToolOwnerRef } from '../toolSources/resolver';

export const TERMINAL_FLOW_RUN_STATUSES: readonly FlowRunStatus[] = ['completed', 'failed', 'cancelled', 'expired'];
export const ACTIVE_FLOW_RUN_STATUSES: readonly FlowRunStatus[] = ['queued', 'running', 'waiting', 'awaiting_approval'];

const leaseInterval = (): SQL => sql`now() + (${FLOW_RUN_LIMITS.leaseTtlMs}::int * interval '1 millisecond')`;

/** The run columns a checkpoint may write. Identity, provenance and the lease pair are not patchable. */
export interface FlowRunPatchColumns {
  status?: FlowRunStatus;
  currentStepId?: string | null;
  currentItemIndex?: number | null;
  activeMs?: number;
  wakeAt?: Date | null;
  errorCode?: FlowRunRow['errorCode'];
  error?: string | null;
  finishedAt?: Date | null;
  resumeSeq?: number;
  startedAt?: Date | null;
  lastHeartbeatAt?: Date | null;
}

// ── reads ────────────────────────────────────────────────────────────────

export interface SliceFlowRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  status: string;
  name: string;
  enabledPublicationSeq: number | null;
}

export interface SliceSnapshot {
  run: FlowRunRow;
  publication: FlowVersionRow | null;
  flow: SliceFlowRow | null;
  /** organizations.partner_id of the RUN org. */
  orgPartnerId: string | null;
  /** `wake_at > now()` on the DB clock (an early wake of a waiting run). */
  wakePending: boolean;
}

export async function loadSliceSnapshot(runId: string): Promise<SliceSnapshot | null> {
  const [row] = await db
    .select({
      run: flowRuns,
      wakePending: sql<boolean>`(${flowRuns.wakeAt} IS NOT NULL AND ${flowRuns.wakeAt} > now())`,
    })
    .from(flowRuns)
    .where(eq(flowRuns.id, runId))
    .limit(1);
  if (!row) return null;
  const run = row.run;
  const [publication] = await db
    .select()
    .from(flowVersions)
    .where(and(eq(flowVersions.id, run.flowVersionId), eq(flowVersions.flowId, run.flowId)))
    .limit(1);
  const [flow] = await db
    .select({
      id: flows.id,
      orgId: flows.orgId,
      partnerId: flows.partnerId,
      status: flows.status,
      name: flows.name,
      enabledPublicationSeq: flows.enabledPublicationSeq,
    })
    .from(flows)
    .where(eq(flows.id, run.flowId))
    .limit(1);
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, run.orgId))
    .limit(1);
  return {
    run,
    publication: publication ?? null,
    flow: flow ?? null,
    orgPartnerId: org?.partnerId ?? null,
    wakePending: row.wakePending === true,
  };
}

/** Every step row of the run, oldest attempt first. */
export async function loadStepRows(runId: string): Promise<FlowRunStepRow[]> {
  return db
    .select()
    .from(flowRunSteps)
    .where(eq(flowRunSteps.runId, runId))
    .orderBy(flowRunSteps.stepId, flowRunSteps.itemIndex, flowRunSteps.attempt);
}

export interface ParkedIntentRow {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  executedAt: Date | null;
  decidedByUserId: string | null;
}

/** The flow-origin intent a step parked on, fenced to the run that minted it. */
export async function loadParkedIntent(runId: string, intentId: string): Promise<ParkedIntentRow | null> {
  const [row] = await db
    .select({
      id: actionIntents.id,
      status: actionIntents.status,
      result: actionIntents.result,
      errorCode: actionIntents.errorCode,
      executedAt: actionIntents.executedAt,
      decidedByUserId: actionIntents.decidedByUserId,
    })
    .from(actionIntents)
    .where(and(eq(actionIntents.id, intentId), eq(actionIntents.requestingFlowRunId, runId)))
    .limit(1);
  return row ?? null;
}

export interface RunControlRow {
  status: FlowRunStatus;
  cancelRequestedAt: Date | null;
  leaseToken: string | null;
}

/** The between-steps re-read: an outside cancel or terminal write since the slice started. */
export async function readRunControl(runId: string): Promise<RunControlRow | null> {
  const [row] = await db
    .select({ status: flowRuns.status, cancelRequestedAt: flowRuns.cancelRequestedAt, leaseToken: flowRuns.leaseToken })
    .from(flowRuns)
    .where(eq(flowRuns.id, runId))
    .limit(1);
  return row ?? null;
}

// ── lease (Decision 15) ─────────────────────────────────────────────────────

/**
 * CAS: status ∈ expect AND (no lease OR it has expired, on the DB clock) ⇒
 * a fresh token. Returns the run row as it now stands, or null.
 */
export async function casAcquireLease(runId: string, expect: readonly FlowRunStatus[]): Promise<FlowRunRow | null> {
  if (expect.length === 0) return null;
  const [row] = await db
    .update(flowRuns)
    .set({ leaseToken: sql`gen_random_uuid()`, leaseExpiresAt: leaseInterval(), updatedAt: new Date() })
    .where(and(
      eq(flowRuns.id, runId),
      inArray(flowRuns.status, [...expect]),
      or(isNull(flowRuns.leaseToken), sql`${flowRuns.leaseExpiresAt} < now()`),
    ))
    .returning();
  return row ?? null;
}

/**
 * THE fence: a run write lands only while `lease_token = token` and the run
 * is not terminal. `lease: 'renew'` pushes the lease out; `'release'` clears
 * the pair (park, terminal). Returns whether a row was written.
 */
export async function fencedRunUpdate(
  runId: string,
  token: string,
  patch: FlowRunPatchColumns,
  lease: 'renew' | 'release',
): Promise<boolean> {
  const rows = await db
    .update(flowRuns)
    .set({
      ...patch,
      ...(patch.error !== undefined && patch.error !== null ? { error: patch.error.slice(0, 2000) } : {}),
      ...(lease === 'release'
        ? { leaseToken: null, leaseExpiresAt: null }
        : { leaseExpiresAt: leaseInterval() }),
      updatedAt: new Date(),
    })
    .where(and(
      eq(flowRuns.id, runId),
      eq(flowRuns.leaseToken, token),
      notInArray(flowRuns.status, [...TERMINAL_FLOW_RUN_STATUSES]),
    ))
    .returning({ id: flowRuns.id });
  return rows.length > 0;
}

/** Heartbeat renewal, same fence as a checkpoint. */
export async function renewLease(runId: string, token: string): Promise<boolean> {
  const rows = await db
    .update(flowRuns)
    .set({ leaseExpiresAt: leaseInterval(), lastHeartbeatAt: sql`now()` })
    .where(and(
      eq(flowRuns.id, runId),
      eq(flowRuns.leaseToken, token),
      notInArray(flowRuns.status, [...TERMINAL_FLOW_RUN_STATUSES]),
    ))
    .returning({ id: flowRuns.id });
  return rows.length > 0;
}

/** Drop the lease if (and only if) this token still holds it. */
export async function releaseLease(runId: string, token: string): Promise<void> {
  await db
    .update(flowRuns)
    .set({ leaseToken: null, leaseExpiresAt: null })
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.leaseToken, token)));
}

// ── step ledger ─────────────────────────────────────────────────────────────

/** A conflict on flow_run_steps_attempt_uq throws (23505): another worker owns that attempt. */
export async function insertStepRow(values: NewFlowRunStepRow): Promise<void> {
  await db.insert(flowRunSteps).values({
    ...values,
    ...(typeof values.error === 'string' ? { error: values.error.slice(0, 2000) } : {}),
  });
}

export async function updateStepRow(runId: string, stepRowId: string, values: Partial<FlowRunStepRow>): Promise<void> {
  await db
    .update(flowRunSteps)
    .set({
      ...values,
      ...(typeof values.error === 'string' ? { error: values.error.slice(0, 2000) } : {}),
    })
    .where(and(eq(flowRunSteps.id, stepRowId), eq(flowRunSteps.runId, runId)));
}

// ── admission (Decision 8) ─────────────────────────────────────────────────

export function flowOwnerKey(owner: ToolOwnerRef): string {
  return owner.orgId ? `org:${owner.orgId}` : `partner:${owner.partnerId}`;
}

/** Serializes every slot decision of one flow owner until the transaction ends. */
export async function lockOwnerSlots(ownerKey: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flow_run_slots:${ownerKey}`}, 0))`);
}

/** The runs of flows this owner owns (org flow ⇒ flows.org_id; partner-wide ⇒ org_id NULL + partner_id). */
function ownerFlowIds(owner: ToolOwnerRef) {
  const ownerPredicate = owner.orgId
    ? eq(flows.orgId, owner.orgId)
    : and(isNull(flows.orgId), eq(flows.partnerId, owner.partnerId));
  return db.select({ id: flows.id }).from(flows).where(ownerPredicate);
}

export interface SlotSnapshot {
  self: { status: FlowRunStatus; leaseToken: string | null } | null;
  /** Another run of the same (flow, org) is `running`. */
  otherRunningForFlowOrg: boolean;
  /** `running` runs of the owner's flows, this run excluded. */
  ownerRunning: number;
}

export async function loadSlotSnapshot(
  run: { id: string; flowId: string; orgId: string },
  owner: ToolOwnerRef,
): Promise<SlotSnapshot> {
  const [self] = await db
    .select({ status: flowRuns.status, leaseToken: flowRuns.leaseToken })
    .from(flowRuns)
    .where(eq(flowRuns.id, run.id))
    .limit(1);
  const [other] = await db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(and(
      eq(flowRuns.flowId, run.flowId),
      eq(flowRuns.orgId, run.orgId),
      eq(flowRuns.status, 'running'),
      sql`${flowRuns.id} <> ${run.id}`,
    ))
    .limit(1);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flowRuns)
    .where(and(
      eq(flowRuns.status, 'running'),
      sql`${flowRuns.id} <> ${run.id}`,
      inArray(flowRuns.flowId, ownerFlowIds(owner)),
    ));
  return { self: self ?? null, otherRunningForFlowOrg: !!other, ownerRunning: Number(count?.n ?? 0) };
}

/**
 * queued | waiting | awaiting_approval → running, conditional on the lease.
 * Clears wake_at in the same write (flow_runs_waiting_chk).
 */
export async function casRunToRunning(runId: string, token: string): Promise<boolean> {
  const rows = await db
    .update(flowRuns)
    .set({
      status: 'running',
      wakeAt: null,
      startedAt: sql`COALESCE(${flowRuns.startedAt}, now())`,
      leaseExpiresAt: leaseInterval(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(flowRuns.id, runId),
      eq(flowRuns.leaseToken, token),
      inArray(flowRuns.status, ['queued', 'waiting', 'awaiting_approval']),
    ))
    .returning({ id: flowRuns.id });
  return rows.length > 0;
}

/** queued + running + waiting + awaiting_approval runs of the owner's flows. */
export async function countActiveRunsForOwner(owner: ToolOwnerRef): Promise<number> {
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flowRuns)
    .where(and(inArray(flowRuns.status, [...ACTIVE_FLOW_RUN_STATUSES]), inArray(flowRuns.flowId, ownerFlowIds(owner))));
  return Number(count?.n ?? 0);
}
