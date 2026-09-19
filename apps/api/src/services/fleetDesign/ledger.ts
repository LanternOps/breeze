/**
 * Fleet Design apply ledger (Fleet Designer W03, #5653; spec §4.8, §4.11).
 *
 * THE ONLY WRITER of `fleet_design_applied_items`. One row per applied item
 * ref; `UNIQUE (report_run_id, item_ref)` is the idempotency key, so every
 * insert goes through `onConflictDoNothing` — a unique violation raised inside
 * the request's ambient transaction would abort it at COMMIT even when caught
 * (`assignPolicy` documents the same trap), so the conflict is never allowed
 * to raise in the first place.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FleetDesignBeforeImage, FleetDesignCreatedRefs, FleetDesignLedgerItem, FleetDesignLedgerKind, FleetDesignOutcome, FleetDesignReportSummary } from '@breeze/shared';
import { db } from '../../db';
import { deviceGroups, fleetDesignAppliedItems, reportRuns, reports } from '../../db/schema';
import { FLEET_DESIGN_REPORT_TYPE } from '../aiAgents/fleetDesignReport';

type LedgerExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>;

export type FleetDesignLedgerRow = typeof fleetDesignAppliedItems.$inferSelect;

export interface RecordLedgerInput {
  orgId: string;
  reportRunId: string;
  itemRef: string;
  itemKind: FleetDesignLedgerKind;
  step: number;
  createdRefs?: FleetDesignCreatedRefs;
  beforeImage?: FleetDesignBeforeImage | null;
  userId: string | null;
}

export async function loadLedger(reportRunId: string, orgId: string): Promise<FleetDesignLedgerRow[]> {
  return db
    .select()
    .from(fleetDesignAppliedItems)
    .where(and(eq(fleetDesignAppliedItems.reportRunId, reportRunId), eq(fleetDesignAppliedItems.orgId, orgId)))
    .orderBy(fleetDesignAppliedItems.step, fleetDesignAppliedItems.appliedAt);
}

/**
 * Insert an `applied` row. Returns the row, or `null` when `(report_run_id,
 * item_ref)` already existed — the caller treats null as "already applied,
 * skip", exactly as `assignPolicy` treats its null.
 */
export async function recordApplied(input: RecordLedgerInput, database: LedgerExecutor = db): Promise<FleetDesignLedgerRow | null> {
  const [row] = await database
    .insert(fleetDesignAppliedItems)
    .values({
      orgId: input.orgId,
      reportRunId: input.reportRunId,
      itemRef: input.itemRef,
      itemKind: input.itemKind,
      status: 'applied',
      step: input.step,
      createdRefs: input.createdRefs ?? {},
      beforeImage: input.beforeImage ?? null,
      appliedByUserId: input.userId,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Same as `recordApplied` with `status: 'failed'` and the error text (bounded). */
export async function recordFailed(input: RecordLedgerInput & { error: string }): Promise<FleetDesignLedgerRow | null> {
  const [row] = await db
    .insert(fleetDesignAppliedItems)
    .values({
      orgId: input.orgId,
      reportRunId: input.reportRunId,
      itemRef: input.itemRef,
      itemKind: input.itemKind,
      status: 'failed',
      step: input.step,
      createdRefs: input.createdRefs ?? {},
      beforeImage: input.beforeImage ?? null,
      error: input.error.slice(0, 500),
      appliedByUserId: input.userId,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Refresh `created_refs` on an applied row (a second apply in the same run unions monitoring into the same policy). */
export async function updateCreatedRefs(id: string, orgId: string, createdRefs: FleetDesignCreatedRefs, database: LedgerExecutor = db): Promise<void> {
  await database
    .update(fleetDesignAppliedItems)
    .set({ createdRefs })
    .where(and(eq(fleetDesignAppliedItems.id, id), eq(fleetDesignAppliedItems.orgId, orgId)));
}

export async function markRolledBack(ids: string[], orgId: string, userId: string | null): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(fleetDesignAppliedItems)
    .set({ status: 'rolled_back', rolledBackAt: new Date(), rolledBackByUserId: userId })
    .where(and(
      inArray(fleetDesignAppliedItems.id, ids),
      eq(fleetDesignAppliedItems.orgId, orgId),
      eq(fleetDesignAppliedItems.status, 'applied'),
    ));
}

/**
 * The group a previous apply created (or reused) for this (org, function),
 * if it still exists. Only `applied` rows count — a rolled-back apply's group
 * was deleted (or handed back to the technician) and must not be re-adopted.
 * A technician-renamed group is still reused: the id is the identity.
 */
export async function findReusableGroup(orgId: string, functionKey: string, database: LedgerExecutor = db): Promise<{ groupId: string } | null> {
  const rows = await database
    .select({ createdRefs: fleetDesignAppliedItems.createdRefs })
    .from(fleetDesignAppliedItems)
    .where(and(
      eq(fleetDesignAppliedItems.orgId, orgId),
      eq(fleetDesignAppliedItems.itemRef, `functions:${functionKey}`),
      eq(fleetDesignAppliedItems.itemKind, 'function'),
      eq(fleetDesignAppliedItems.status, 'applied'),
    ))
    .orderBy(desc(fleetDesignAppliedItems.appliedAt))
    .limit(20);

  const candidateIds = [...new Set(rows.map((r) => r.createdRefs?.groupId).filter((id): id is string => typeof id === 'string'))];
  if (candidateIds.length === 0) return null;

  const existing = await database
    .select({ id: deviceGroups.id })
    .from(deviceGroups)
    .where(and(inArray(deviceGroups.id, candidateIds), eq(deviceGroups.orgId, orgId)));
  const alive = new Set(existing.map((g) => g.id));
  const first = candidateIds.find((id) => alive.has(id));
  return first ? { groupId: first } : null;
}

export interface LockedReportRun {
  reportRunId: string;
  reportId: string;
  orgId: string;
  outcome: FleetDesignOutcome | null;
  summary: FleetDesignReportSummary | null;
}

/**
 * Lock the report run (`FOR UPDATE OF report_runs`) for the duration of the
 * request transaction so two concurrent applies of the same design serialise
 * on the row, and return its org + stored outcome in the same round trip.
 * Null for "does not exist / not a Fleet Design / not the caller's" alike.
 */
export async function lockReportRun(
  reportRunId: string,
  orgCondition: (orgId: AnyPgColumn) => SQL<unknown> | undefined,
): Promise<LockedReportRun | null> {
  const [row] = await db
    .select({
      reportRunId: reportRuns.id,
      reportId: reports.id,
      orgId: reports.orgId,
      summary: sql<FleetDesignReportSummary | null>`${reportRuns.result}->'summary'`,
    })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(
      eq(reportRuns.id, reportRunId),
      eq(reports.type, FLEET_DESIGN_REPORT_TYPE),
      orgCondition(reports.orgId),
    ))
    .limit(1)
    .for('update', { of: reportRuns });
  if (!row) return null;
  return {
    reportRunId: row.reportRunId,
    reportId: row.reportId,
    orgId: row.orgId,
    summary: row.summary ?? null,
    outcome: row.summary?.fleetDesign?.outcome ?? null,
  };
}

export function toLedgerItem(row: FleetDesignLedgerRow): FleetDesignLedgerItem {
  return {
    id: row.id,
    itemRef: row.itemRef,
    itemKind: row.itemKind,
    status: row.status,
    step: row.step,
    createdRefs: (row.createdRefs ?? {}) as Record<string, unknown>,
    error: row.error ?? null,
    appliedAt: row.appliedAt instanceof Date ? row.appliedAt.toISOString() : String(row.appliedAt),
    rolledBackAt: row.rolledBackAt ? (row.rolledBackAt instanceof Date ? row.rolledBackAt.toISOString() : String(row.rolledBackAt)) : null,
  };
}
