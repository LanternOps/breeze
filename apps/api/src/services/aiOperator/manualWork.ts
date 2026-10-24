/**
 * Manual work for multi-item human-work steps (Recipe Library spec §6.5,
 * D-R1-5; W06 R1a Task 10).
 *
 * E3's `openHumanWorkStep` creates one checklist item per step row and its
 * wake is per item. Applied naively that serializes a technician's parallel
 * jobs ("collect the laptop" would not appear until "transfer files" was
 * ticked). So the `manual_work` step creates EVERY item up front, each with
 * its own `manual_work` step row whose `attempt_ordinal` IS the item's index,
 * and both link directions — the owning `ai_operator_task_steps.
 * checklist_item_id` and the provenance `ticket_checklist_items.
 * operator_step_id` — are written together. Ticking any item wakes the task
 * through E3's `onChecklistItemDone`, so items can be done in any order.
 *
 * DEDUPE ON STEP IDENTITY, NEVER ON `(ticket_id, label)`. "Does item i
 * already exist?" is answered by the step row `(org, task, 'manual_work',
 * attempt_ordinal = i)` carrying a `checklist_item_id`. A label is not an
 * identity: two tasks on one ticket can generate the same label, an org-move
 * re-stamps the item's org but never the step's, and a technician may edit a
 * label. The items are generated in the recipe's stable, key-deduplicated
 * order, so index i means the same item on every wake.
 *
 * Reuses E2/E3's writers (`ensureTaskTicket`, `openStep`, `markStepWaiting`)
 * and redefines none of them. The Operator creates items and NEVER completes
 * one: nothing here writes `done_at` or `done_by_user_id` (E3's contract test
 * covers this directory).
 *
 * Every write runs in the caller's ONE leased transaction (the bare `db`
 * handle joins it); the read runs in system scope with the item join
 * constrained to the TASK's org, exactly like `readHumanWorkStep`.
 */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorTaskSteps } from '../../db/schema/aiOperatorTaskGraph';
import { ticketChecklistItems } from '../../db/schema/ticketChecklists';
import { assertTicketNotMerged } from '../ticketMerge/errors';
import { lockTicketForWrite } from '../ticketRowLock';
import { ensureTaskTicket, type HumanWorkDbHandle } from './humanWorkService';
import { markStepWaiting, openStep } from './stepService';
import type { IdentityManualWorkItem } from './recipes/identityOffboarding';

export const MANUAL_WORK_STEP_KEY = 'manual_work';
/** Mirrors `ticket_checklist_items.label` varchar(500). */
export const MANUAL_ITEM_LABEL_MAX = 500;
const MANUAL_ITEM_DETAIL_MAX = 2000;
/** The bound on `manualWorkCursor` in the identity checkpoint arm. */
export const MANUAL_WORK_MAX_ITEMS = 64;

/** Truncate VISIBLY: an ellipsis, never a silent cut. */
export function clipLabel(label: string, max = MANUAL_ITEM_LABEL_MAX): string {
  const t = label.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export interface EnsureManualWorkItemsResult {
  ticketId: string;
  /** Item ids in index order. */
  itemIds: string[];
  /** How many items this call inserted (0 on a re-entry). */
  created: number;
}

export interface AttachHumanWorkStepInput {
  task: { id: string; orgId: string; revision: number };
  stepKey: string;
  attemptOrdinal: number;
  targetId?: string | null;
  checklistItemId: string;
  label: string;
  remindAfterMs?: number | null;
  now?: Date;
}

/**
 * Open a step row bound to an item that ALREADY exists: the step row, both
 * link pointers and the step's typed wait, in the caller's transaction.
 */
export async function attachHumanWorkStep(
  dbh: HumanWorkDbHandle,
  input: AttachHumanWorkStepInput,
): Promise<{ stepId: string }> {
  const now = input.now ?? new Date();
  const step = await openStep(dbh, {
    orgId: input.task.orgId,
    taskId: input.task.id,
    stepKey: input.stepKey,
    stepKind: 'human_work',
    targetId: input.targetId ?? null,
    attemptOrdinal: input.attemptOrdinal,
    planRevision: input.task.revision,
    expectedCriterion: input.label.slice(0, 2000),
  });
  await dbh
    .update(aiOperatorTaskSteps)
    .set({
      checklistItemId: input.checklistItemId,
      remindAfterAt: input.remindAfterMs ? new Date(now.getTime() + input.remindAfterMs) : null,
      remindedAt: null,
      updatedAt: now,
    })
    .where(and(eq(aiOperatorTaskSteps.id, step.id), eq(aiOperatorTaskSteps.orgId, input.task.orgId)));
  await dbh
    .update(ticketChecklistItems)
    .set({ operatorStepId: step.id, updatedAt: now })
    .where(and(eq(ticketChecklistItems.id, input.checklistItemId), eq(ticketChecklistItems.orgId, input.task.orgId)));
  await markStepWaiting(dbh, {
    orgId: input.task.orgId,
    taskId: input.task.id,
    stepKey: input.stepKey,
    targetId: input.targetId ?? null,
    attemptOrdinal: input.attemptOrdinal,
    dependencyKind: 'user_answer',
    dependencyId: input.checklistItemId,
  });
  return { stepId: step.id };
}

/**
 * Create every outstanding manual item on the task's ticket, each bound to its
 * own `manual_work` step row, idempotently by step identity.
 */
export async function ensureManualWorkItems(
  dbh: HumanWorkDbHandle,
  task: { id: string; orgId: string; objective: string; revision: number },
  items: readonly IdentityManualWorkItem[],
  opts: { targetId?: string | null; remindAfterMs?: number | null; now?: Date } = {},
): Promise<EnsureManualWorkItemsResult> {
  if (items.length > MANUAL_WORK_MAX_ITEMS) {
    // Refuse before writing anything: the cursor's bound is 64.
    throw new Error(`[manualWork] ${items.length} manual items exceed the bound of ${MANUAL_WORK_MAX_ITEMS}`);
  }
  const { ticketId } = await ensureTaskTicket(dbh, task);

  const existing = await dbh
    .select({ index: aiOperatorTaskSteps.attemptOrdinal, checklistItemId: aiOperatorTaskSteps.checklistItemId })
    .from(aiOperatorTaskSteps)
    .where(and(
      eq(aiOperatorTaskSteps.orgId, task.orgId),
      eq(aiOperatorTaskSteps.taskId, task.id),
      eq(aiOperatorTaskSteps.stepKey, MANUAL_WORK_STEP_KEY),
      isNotNull(aiOperatorTaskSteps.checklistItemId),
    ));
  const byIndex = new Map(existing.map((r) => [r.index, r.checklistItemId!]));

  const missing = items.map((_, i) => i).filter((i) => !byIndex.has(i));
  if (missing.length > 0) {
    // Ticket first, before the MAX(position) read and the item writes (#8972 W0).
    // A tombstone is refused under the lock (#8972 W1): the merge re-pointed
    // the task's target, so the coordinator's retry lands on the survivor.
    assertTicketNotMerged(await lockTicketForWrite(dbh, ticketId));
    const [agg] = await dbh
      .select({ maxPosition: sql<number | null>`MAX(${ticketChecklistItems.position})` })
      .from(ticketChecklistItems)
      .where(eq(ticketChecklistItems.ticketId, ticketId));
    let position = (agg?.maxPosition ?? -1) + 1;
    for (const i of missing) {
      const item = items[i]!;
      const label = clipLabel(item.label);
      const [row] = await dbh
        .insert(ticketChecklistItems)
        .values({
          orgId: task.orgId,
          ticketId,
          label,
          detail: item.detail ? clipLabel(item.detail, MANUAL_ITEM_DETAIL_MAX) : null,
          position,
          source: 'operator_task',
          // NULL: `created_by` is a real FK to users; source says where it came from.
          createdBy: null,
        })
        .returning({ id: ticketChecklistItems.id });
      if (!row) throw new Error(`[manualWork] checklist item insert returned no row for task ${task.id}`);
      position += 1;
      await attachHumanWorkStep(dbh, {
        task, stepKey: MANUAL_WORK_STEP_KEY, attemptOrdinal: i, targetId: opts.targetId ?? null,
        checklistItemId: row.id, label, remindAfterMs: opts.remindAfterMs ?? null, now: opts.now,
      });
      byIndex.set(i, row.id);
    }
  }

  return { ticketId, itemIds: items.map((_, i) => byIndex.get(i)!), created: missing.length };
}

export interface ManualWorkRow {
  index: number;
  stepId: string;
  stepState: string;
  checklistItemId: string | null;
  /** Null when the item is no longer readable in the TASK's org (moved or erased). */
  itemLabel: string | null;
  itemDoneAt: Date | null;
  itemDoneByUserId: string | null;
}

/** The authoritative read: every manual_work step row of the task, joined to its item within the task's org. */
export async function readManualWork(orgId: string, taskId: string): Promise<ManualWorkRow[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => db
      .select({
        index: aiOperatorTaskSteps.attemptOrdinal,
        stepId: aiOperatorTaskSteps.id,
        stepState: aiOperatorTaskSteps.state,
        checklistItemId: aiOperatorTaskSteps.checklistItemId,
        itemLabel: ticketChecklistItems.label,
        itemDoneAt: ticketChecklistItems.doneAt,
        itemDoneByUserId: ticketChecklistItems.doneByUserId,
      })
      .from(aiOperatorTaskSteps)
      .leftJoin(ticketChecklistItems, and(
        eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId),
        eq(ticketChecklistItems.orgId, aiOperatorTaskSteps.orgId),
      ))
      .where(and(
        eq(aiOperatorTaskSteps.orgId, orgId),
        eq(aiOperatorTaskSteps.taskId, taskId),
        eq(aiOperatorTaskSteps.stepKey, MANUAL_WORK_STEP_KEY),
        eq(aiOperatorTaskSteps.stepKind, 'human_work'),
      ))
      .orderBy(asc(aiOperatorTaskSteps.attemptOrdinal))));
}

/**
 * The next item the cursor should wait on, skipping anything already done.
 * A technician who ticks out of order simply advances the cursor faster.
 * Null when every item from `fromIndex` on is done.
 */
export function nextOpenManualItem(
  rows: readonly ManualWorkRow[],
  fromIndex: number,
): { index: number; itemId: string } | null {
  for (const row of [...rows].sort((a, b) => a.index - b.index)) {
    if (row.index < fromIndex) continue;
    if (row.itemDoneAt) continue;
    if (!row.checklistItemId) continue;
    return { index: row.index, itemId: row.checklistItemId };
  }
  return null;
}
