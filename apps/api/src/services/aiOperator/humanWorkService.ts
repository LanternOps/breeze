// AI Operator human-work steps (Recipe Library wave E3, spec §5.3 and §6.5).
//
// WHY THIS FILE EXISTS: a `human_work` step is the one step kind whose
// completion is written by someone OUTSIDE the Operator — a technician ticking
// a checklist item on a ticket. That makes it the only place the Operator's
// object graph and the ticket system touch, and it deserves exactly one writer
// so the two sides can never drift about which row owns the link, which org
// each row is in, or what happens when they stop agreeing.
//
// THE OPERATOR CREATES ITEMS AND NEVER COMPLETES THEM (spec §6.5). There is no
// `done_at` write anywhere in this file, and `humanWorkPurity.test.ts` scans
// the whole `services/aiOperator/` tree to keep it that way. Completion is a
// human attestation on a compliance artifact; an agent that could tick its own
// checklist would be grading its own homework.
//
// ATOMICITY. Every write takes the caller's handle (`dbh`), exactly like
// `enqueueTaskOutbox` (taskOutbox.ts), `appendTaskEvent` (eventService.ts)
// and `openStep` (stepService.ts). The request path is already one Postgres
// transaction (`withDbAccessContext`, db/index.ts) and the bare `db` proxy
// joins it, so `patchChecklistItem`'s guarded `done_at` UPDATE and the wake
// this file enqueues commit together or not at all. NO `db.transaction()` is
// opened here.
//
// IMPORT DIRECTION IS ONE-WAY: `ticketChecklistService` imports THIS module,
// never the reverse. That is why the checklist-item insert below is written
// against the Drizzle table directly instead of calling `addChecklistItem` —
// which also hardcodes `source: 'manual'` and stamps `createdBy: actor.userId`,
// neither of which is right for an Operator-created row.
//
// THE LINK IS DETACHED, NEVER RE-STAMPED. `ticket_checklist_items.org_id` moves
// with its ticket; `ai_operator_task_steps.org_id` is immutable task history.
// When they diverge, `detachHumanWorkLinksForTicket` nulls the pointer and
// wakes the task, and the coordinator's authoritative re-read turns that into a
// classified handoff. See migration 2026-10-26-170100's header note A.

import { and, desc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskSteps, aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { ticketChecklistItems } from '../../db/schema/ticketChecklists';
import { ticketComments } from '../../db/schema/portal';
import { createTicket } from '../ticketService';
import { createNotification } from '../userNotifications';
import { createTaskTarget } from './targetService';
import { appendTaskEvent } from './eventService';
import { markStepWaiting, openStep } from './stepService';
import { enqueueTaskOutbox } from './taskOutbox';

/** Mirrors `ticket_checklist_items.label` varchar(500). */
const MAX_ITEM_LABEL_CHARS = 500;
/** Mirrors the `detail` bound the checklist validators use. */
const MAX_ITEM_DETAIL_CHARS = 2000;
/** Bounded scan per reconciler tick, matching the reconciler's own discipline. */
const HUMAN_WORK_REMINDER_SCAN_LIMIT = 50;

/**
 * The principal the Operator creates tickets and checklist items as.
 *
 * `createTicket` requires a `TicketActor` with a non-null `userId` and the
 * Operator is not a `users` row, so the nil UUID is the established stand-in —
 * `DELIVERABLE_SWEEP_ACTOR` (services/serviceDeliverableService.ts) does
 * exactly this. The checklist item's own `created_by` is left NULL rather than
 * given the nil UUID, because that column IS a real FK to `users` and
 * nullability is the documented system-provenance marker there;
 * `source = 'operator_task'` is what says where the row came from.
 */
export const OPERATOR_TASK_ACTOR = {
  userId: '00000000-0000-0000-0000-000000000000',
  name: 'AI Operator',
} as const;

/**
 * The `transitionSeq` for a `user_answer` wake.
 *
 * FIXED, not a counter, and that is deliberate — the same "terminal status
 * ordinal" scheme `RUN_TERMINAL_OUTBOX_TRANSITION_SEQ` and
 * `INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ` use (taskOutbox.ts). The `sourceId`
 * is the CHECKLIST ITEM id, so two human-work steps on one task never share a
 * row; and a re-tick after an untick reuses the same identity, which is what
 * makes `ON CONFLICT DO NOTHING` collapse it rather than wake a task whose step
 * has already settled and moved on.
 */
export const CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ = 1;

/**
 * The polling fallback for a human-work wait.
 *
 * The EVENT path (a tick → an outbox row → a wake) is how this normally
 * resolves. This is the backstop for a lost wake, and it is long on purpose: a
 * waiting task holds nothing, and re-entering `advanceHumanWork` every six
 * hours to re-read one row costs nothing either.
 */
export const HUMAN_WORK_POLL_WAKE_MS = 6 * 60 * 60 * 1000;

export type HumanWorkDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/** Refusal for deleting a checklist item an Operator step is still waiting on. */
export class HumanWorkStepWaitingError extends Error {
  readonly status = 409 as const;
  readonly code = 'CHECKLIST_OPERATOR_STEP_WAITING' as const;
  constructor(message: string) {
    super(message);
    this.name = 'HumanWorkStepWaitingError';
  }
}

export interface EnsureTaskTicketResult {
  ticketId: string;
  targetId: string;
  created: boolean;
}

/**
 * The task's ticket, creating one if it has none (spec §6.5: "a task with
 * human-work steps requires a ticket; admission creates one if absent").
 *
 * The ticket is reached through an E2 `ticket` TARGET ROW, not through a column
 * on `ai_operator_tasks` — that table has no ticket pointer and gains none
 * (decision D3). "Do not create a second ticket queue" holds: the ticket is the
 * business record the technician already works from.
 */
export async function ensureTaskTicket(
  dbh: HumanWorkDbHandle,
  task: { id: string; orgId: string; objective: string },
): Promise<EnsureTaskTicketResult> {
  const [existing] = await dbh
    .select({ id: aiOperatorTaskTargets.id, ticketId: aiOperatorTaskTargets.ticketId })
    .from(aiOperatorTaskTargets)
    .where(and(
      eq(aiOperatorTaskTargets.orgId, task.orgId),
      eq(aiOperatorTaskTargets.taskId, task.id),
      eq(aiOperatorTaskTargets.targetKind, 'ticket'),
      isNotNull(aiOperatorTaskTargets.ticketId),
    ))
    .orderBy(aiOperatorTaskTargets.targetOrdinal)
    .limit(1);

  if (existing?.ticketId) {
    return { ticketId: existing.ticketId, targetId: existing.id, created: false };
  }

  // `source: 'ai'` is the shipped ticket source for agent-created work
  // (db/schema/portal.ts). `workKind` is left at its 'support' default: this
  // ticket carries real, SLA-bearing work a technician must do.
  const ticket = await createTicket({
    orgId: task.orgId,
    source: 'ai',
    subject: task.objective.slice(0, 255),
    description:
      'Opened by the AI Operator because this task has work only a person can do. '
      + 'The checklist below is the work; tick each step as you complete it.',
  }, OPERATOR_TASK_ACTOR);

  const [agg] = await dbh
    .select({ maxOrdinal: sql<number | null>`MAX(${aiOperatorTaskTargets.targetOrdinal})` })
    .from(aiOperatorTaskTargets)
    .where(and(
      eq(aiOperatorTaskTargets.orgId, task.orgId),
      eq(aiOperatorTaskTargets.taskId, task.id),
    ));

  const target = await createTaskTarget(dbh, {
    orgId: task.orgId,
    taskId: task.id,
    targetKind: 'ticket',
    ticketId: ticket.id,
    targetLabel: task.objective.slice(0, 255),
    targetOrdinal: (agg?.maxOrdinal ?? -1) + 1,
  });

  await appendTaskEvent(dbh, {
    orgId: task.orgId,
    taskId: task.id,
    eventType: 'target_attached',
    actor: { kind: 'coordinator' },
    targetId: target.id,
    detail: `opened ticket ${ticket.id} for human work`,
  });

  return { ticketId: ticket.id, targetId: target.id, created: true };
}

export interface OpenHumanWorkStepInput {
  task: { id: string; orgId: string; objective: string; revision: number; attemptOrdinal: number };
  stepKey: string;
  /** The `ai_operator_task_targets` row this work is about, if any. */
  targetId?: string | null;
  /** What the technician must do. Becomes the checklist item's label. */
  label: string;
  detail?: string | null;
  /** How long until the step is overdue. Null means never remind. */
  remindAfterMs?: number | null;
  /**
   * False when the coordinator's step change already opened this step row
   * (`recordStepChange` → `openStep` with an actor) and wrote its
   * `step_opened` event; the upsert here is then a refresh, and a second
   * `step_opened` on the timeline would claim an opening that did not happen.
   * Defaults to true for callers that open the step from nothing.
   */
  emitOpenEvent?: boolean;
  now?: Date;
}

export interface OpenHumanWorkStepResult {
  stepId: string;
  checklistItemId: string;
  ticketId: string;
}

/**
 * Open a `human_work` step: ticket, checklist item, step row, both link
 * pointers and the typed wait — all in the caller's ONE transaction.
 *
 * All of it or none of it. A step row without its item is a task waiting on a
 * dependency that does not exist; an item without its step is a checklist entry
 * nobody can explain. Splitting these across transactions is how you get both.
 */
export async function openHumanWorkStep(
  dbh: HumanWorkDbHandle,
  input: OpenHumanWorkStepInput,
): Promise<OpenHumanWorkStepResult> {
  const label = input.label.trim();
  // REFUSE FIRST. The column's NOT NULL / length CHECK would also catch this,
  // but a 23514 raised inside the caller's transaction ABORTS it — the caller
  // could not then read back, answer, or even record why. The constraint is the
  // backstop, never the control flow.
  if (!label) {
    throw new Error(`[humanWork] a human_work step needs a non-empty label (step '${input.stepKey}')`);
  }

  const now = input.now ?? new Date();
  const { ticketId } = await ensureTaskTicket(dbh, input.task);

  // Append at the end of the ticket's list, same rule as addChecklistItem
  // (ticketChecklistService.ts). Duplicated rather than imported: the import
  // direction is one-way (see the file header), and four lines of MAX()+1 is
  // a smaller cost than a module cycle.
  const [agg] = await dbh
    .select({ maxPosition: sql<number | null>`MAX(${ticketChecklistItems.position})` })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticketId));

  const [item] = await dbh
    .insert(ticketChecklistItems)
    .values({
      // The TICKET's org, which is also the task's org at this moment. They can
      // diverge later, which is exactly what the detach path exists for.
      orgId: input.task.orgId,
      ticketId,
      label: label.slice(0, MAX_ITEM_LABEL_CHARS),
      detail: input.detail ? input.detail.slice(0, MAX_ITEM_DETAIL_CHARS) : null,
      position: (agg?.maxPosition ?? -1) + 1,
      source: 'operator_task',
      // NULL, not the nil UUID: `created_by` is a real FK to `users` and
      // nullability is the documented system-provenance marker there.
      createdBy: null,
    })
    .returning({ id: ticketChecklistItems.id });

  if (!item) {
    throw new Error(`[humanWork] checklist item insert returned no row for task ${input.task.id}`);
  }

  const step = await openStep(dbh, {
    orgId: input.task.orgId,
    taskId: input.task.id,
    stepKey: input.stepKey,
    stepKind: 'human_work',
    targetId: input.targetId ?? null,
    attemptOrdinal: input.task.attemptOrdinal,
    planRevision: input.task.revision,
    expectedCriterion: label.slice(0, 2000),
    ...(input.emitOpenEvent === false ? {} : { actor: { kind: 'coordinator' as const } }),
  });

  // The step owns the link (migration header note A).
  await dbh
    .update(aiOperatorTaskSteps)
    .set({
      checklistItemId: item.id,
      remindAfterAt: input.remindAfterMs ? new Date(now.getTime() + input.remindAfterMs) : null,
      remindedAt: null,
      updatedAt: now,
    })
    .where(eq(aiOperatorTaskSteps.id, step.id));

  // The item carries the reverse pointer as provenance only (header note B).
  await dbh
    .update(ticketChecklistItems)
    .set({ operatorStepId: step.id, updatedAt: now })
    .where(eq(ticketChecklistItems.id, item.id));

  // The dependency is the ITEM, not the step: it is what a human acts on, and
  // it is what the wake carries as its sourceId.
  await markStepWaiting(dbh, {
    orgId: input.task.orgId,
    taskId: input.task.id,
    stepKey: input.stepKey,
    targetId: input.targetId ?? null,
    attemptOrdinal: input.task.attemptOrdinal,
    dependencyKind: 'user_answer',
    dependencyId: item.id,
    actor: { kind: 'coordinator' },
    detail: `waiting on a person: ${label.slice(0, 200)}`,
  });

  return { stepId: step.id, checklistItemId: item.id, ticketId };
}

export interface HumanWorkStepView {
  stepId: string;
  state: string;
  /**
   * The wait dependency the step was armed with — the item id at link time.
   * Distinguishes a row that was NEVER linked (`dependencyId` null: the step
   * change opened it and the human-work writer has not run yet) from one
   * whose link was DETACHED (`dependencyId` set, `checklistItemId` null).
   */
  dependencyId: string | null;
  checklistItemId: string | null;
  itemDoneAt: Date | null;
  itemDoneByUserId: string | null;
  itemLabel: string | null;
}

/**
 * The AUTHORITATIVE read behind every human-work decision (Operator spec §6.3
 * invariant 2: the coordinator never trusts a wake payload).
 *
 * The item join is constrained on `ticket_checklist_items.org_id = <the TASK's
 * org>`, not merely on the id. That single predicate is what turns a ticket
 * org-move into a clean handoff: after the move the item is in another tenant,
 * the join misses, and the caller sees `checklistItemId` set but `itemLabel`
 * null — which it must treat exactly as a detached link.
 *
 * Runs under a system context like the coordinator's other authoritative
 * reads (`readLatestTaskRun`, `readLatestOperation`): the coordinator has no
 * request context of its own.
 */
export async function readHumanWorkStep(
  orgId: string,
  taskId: string,
  stepKey: string,
  attemptOrdinal: number,
): Promise<HumanWorkStepView | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          stepId: aiOperatorTaskSteps.id,
          state: aiOperatorTaskSteps.state,
          dependencyId: aiOperatorTaskSteps.dependencyId,
          checklistItemId: aiOperatorTaskSteps.checklistItemId,
          itemDoneAt: ticketChecklistItems.doneAt,
          itemDoneByUserId: ticketChecklistItems.doneByUserId,
          itemLabel: ticketChecklistItems.label,
        })
        .from(aiOperatorTaskSteps)
        .leftJoin(ticketChecklistItems, and(
          eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId),
          eq(ticketChecklistItems.orgId, aiOperatorTaskSteps.orgId),
        ))
        .where(and(
          eq(aiOperatorTaskSteps.orgId, orgId),
          eq(aiOperatorTaskSteps.taskId, taskId),
          eq(aiOperatorTaskSteps.stepKey, stepKey),
          eq(aiOperatorTaskSteps.attemptOrdinal, attemptOrdinal),
          eq(aiOperatorTaskSteps.stepKind, 'human_work'),
        ))
        .orderBy(desc(aiOperatorTaskSteps.createdAt))
        .limit(1);

      return row ?? null;
    }));
}

/**
 * Called by `patchChecklistItem` when an item transitions to done, in the
 * SAME transaction as the `done_at` stamp.
 *
 * Enqueues the wake and nothing else. It deliberately does NOT settle the step:
 * settling is a leased task transition and this is a request handler with no
 * lease. The coordinator re-reads and decides (invariant 2).
 */
export async function onChecklistItemDone(
  dbh: HumanWorkDbHandle,
  itemId: string,
): Promise<'enqueued' | 'not_operator_item'> {
  const [link] = await dbh
    .select({ orgId: aiOperatorTaskSteps.orgId, taskId: aiOperatorTaskSteps.taskId })
    .from(aiOperatorTaskSteps)
    .where(eq(aiOperatorTaskSteps.checklistItemId, itemId))
    .limit(1);

  if (!link) return 'not_operator_item';

  await enqueueTaskOutbox(dbh, {
    orgId: link.orgId,
    taskId: link.taskId,
    sourceKind: 'user_answer',
    sourceId: itemId,
    transitionSeq: CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ,
  });
  return 'enqueued';
}

/**
 * Called by `patchChecklistItem` when an operator item is UNTICKED.
 *
 * Spec §6.5: "Un-checking an item after the task advanced writes an event and
 * does not rewind." No wake, no step change, no task change — only a row on the
 * append-only timeline, so a technician reading the record later can see that
 * the tick the Operator acted on was withdrawn. Rewinding would mean re-running
 * effects the task has already dispatched against real customer systems.
 */
export async function onChecklistItemUnticked(
  dbh: HumanWorkDbHandle,
  itemId: string,
): Promise<'recorded' | 'not_operator_item'> {
  const [link] = await dbh
    .select({
      orgId: aiOperatorTaskSteps.orgId,
      taskId: aiOperatorTaskSteps.taskId,
      stepKey: aiOperatorTaskSteps.stepKey,
      state: aiOperatorTaskSteps.state,
    })
    .from(aiOperatorTaskSteps)
    .where(eq(aiOperatorTaskSteps.checklistItemId, itemId))
    .limit(1);

  if (!link) return 'not_operator_item';

  await appendTaskEvent(dbh, {
    orgId: link.orgId,
    taskId: link.taskId,
    eventType: 'human_work_unticked',
    actor: { kind: 'system' },
    stepKey: link.stepKey,
    detail:
      `a person cleared the tick on the checklist item for step '${link.stepKey}' `
      + `(step state: ${link.state}). The task did not rewind.`,
  });
  return 'recorded';
}

/**
 * Refuse to delete a checklist item an Operator step is still waiting on.
 *
 * A PRE-CHECK, not a caught constraint error: the FK is `ON DELETE SET NULL`,
 * so the delete would SUCCEED and silently strand the task on a dependency that
 * no longer exists. There is nothing for the database to raise here — the guard
 * IS the contract. Once the step has settled the item is ordinary history and
 * deleting it is allowed.
 *
 * Takes the request's own handle (the bare `db` proxy joins the request
 * transaction) so the read is in the same snapshot as the delete it guards.
 */
export async function assertChecklistItemDeletable(
  itemId: string,
  dbh: HumanWorkDbHandle = db,
): Promise<void> {
  const [waiting] = await dbh
    .select({ stepKey: aiOperatorTaskSteps.stepKey, taskId: aiOperatorTaskSteps.taskId })
    .from(aiOperatorTaskSteps)
    .where(and(
      eq(aiOperatorTaskSteps.checklistItemId, itemId),
      eq(aiOperatorTaskSteps.state, 'waiting'),
    ))
    .limit(1);

  if (waiting) {
    throw new HumanWorkStepWaitingError(
      'This step belongs to a running AI Operator task and cannot be deleted while the task is waiting on it. '
      + 'Tick it when the work is done, or stop the task first.',
    );
  }
}

/**
 * The bulk twin of assertChecklistItemDeletable, for a delete that removes a
 * ticket's UNTICKED items in one statement (a checklist template applied with
 * `replace_unticked`). Same reason, same refusal: the FK is `ON DELETE SET
 * NULL`, so the bulk delete would silently strand every waiting step on it.
 */
export async function assertTicketUntickedChecklistItemsDeletable(
  ticketId: string,
  dbh: HumanWorkDbHandle = db,
): Promise<void> {
  const [waiting] = await dbh
    .select({ stepKey: aiOperatorTaskSteps.stepKey })
    .from(aiOperatorTaskSteps)
    .innerJoin(ticketChecklistItems, eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId))
    .where(and(
      eq(ticketChecklistItems.ticketId, ticketId),
      isNull(ticketChecklistItems.doneAt),
      eq(aiOperatorTaskSteps.state, 'waiting'),
    ))
    .limit(1);

  if (waiting) {
    throw new HumanWorkStepWaitingError(
      'An unticked step on this ticket belongs to a running AI Operator task, so it cannot be replaced while the task is waiting on it. '
      + 'Apply the template with mode append, tick the step when the work is done, or stop the task first.',
    );
  }
}

/**
 * Detach every human-work link on a ticket and wake the tasks behind them.
 *
 * Called by `moveTicketOrg`. It nulls the STEP's pointer — not the item's
 * provenance column, which stays as evidence — and enqueues a `user_answer`
 * wake per affected task. It does NOT settle anything: a task transition needs
 * a lease, and this runs inside somebody else's transaction. The coordinator's
 * re-read finds `checklist_item_id IS NULL` and hands off with a readable
 * reason, which is E2's detach-never-re-stamp rule applied one level down.
 *
 * Returns how many step rows were detached, so the caller can log a count
 * rather than guess (the migration-cleanup forensic-trail rule, applied to a
 * service).
 */
export async function detachHumanWorkLinksForTicket(
  dbh: HumanWorkDbHandle,
  args: { ticketId: string; reason: string },
): Promise<number> {
  const affected = await dbh
    .select({
      stepId: aiOperatorTaskSteps.id,
      orgId: aiOperatorTaskSteps.orgId,
      taskId: aiOperatorTaskSteps.taskId,
      stepKey: aiOperatorTaskSteps.stepKey,
      checklistItemId: aiOperatorTaskSteps.checklistItemId,
    })
    .from(aiOperatorTaskSteps)
    .innerJoin(ticketChecklistItems, eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId))
    .where(and(
      eq(ticketChecklistItems.ticketId, args.ticketId),
      isNull(aiOperatorTaskSteps.settledAt),
    ));

  for (const row of affected) {
    await dbh
      .update(aiOperatorTaskSteps)
      .set({ checklistItemId: null, updatedAt: new Date() })
      .where(eq(aiOperatorTaskSteps.id, row.stepId));

    await appendTaskEvent(dbh, {
      orgId: row.orgId,
      taskId: row.taskId,
      eventType: 'target_detached',
      actor: { kind: 'system' },
      stepKey: row.stepKey,
      detail: `human-work checklist item detached: ${args.reason}`,
    });

    if (row.checklistItemId) {
      await enqueueTaskOutbox(dbh, {
        orgId: row.orgId,
        taskId: row.taskId,
        sourceKind: 'user_answer',
        sourceId: row.checklistItemId,
        transitionSeq: CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ,
      });
    }
  }

  return affected.length;
}

export interface OverdueHumanWorkRow {
  stepId: string;
  orgId: string;
  taskId: string;
  stepKey: string;
  ticketId: string;
  label: string;
}

/**
 * Report every overdue human-work step, once (spec §6.5).
 *
 * WHY A DIRECT `ticketComments` INSERT rather than `addTicketComment` or
 * `addAiTriageNote`:
 *  - `addTicketComment` requires a `TicketActor` with a non-null `userId`
 *    and the Operator is not a `users` row.
 *  - `addAiTriageNote` DOES accept a null user id, but it is keyed on an
 *    `ai_agent_runs.id` and is idempotent per run
 *    (`ticket_comments_one_ai_note_per_run_uq`), so a second reminder for the
 *    same run would silently return the FIRST comment. A reminder is not a
 *    per-run artifact.
 *
 * ONE TRANSACTION FOR THE WHOLE PASS. `withSystemDbAccessContext` runs its
 * callback inside a single Postgres transaction, so the stamps, comments and
 * notifications for every row in the batch commit or roll back TOGETHER: a
 * throw on row N undoes rows 1..N-1 as well, and the next tick retries the
 * whole batch cleanly. There is no per-row isolation, and none is needed.
 *
 * Within that transaction, `reminded_at` is stamped by a GUARDED update
 * (`WHERE reminded_at IS NULL`) before the side-effects. That guard is what
 * makes two API pods ticking concurrently safe: both may SELECT the same
 * overdue row, but the second pod's UPDATE waits on the row lock, sees the
 * stamp once the first commits, matches nothing, and skips the comment.
 *
 * The system context is also what `createNotification` requires
 * (`runOutsideDbContext(() => withSystemDbAccessContext(...))`); the inner
 * helper is a passthrough under an ambient context, so the wrapper here
 * covers every call and must not be repeated per row.
 */
export async function sendHumanWorkReminders(now: Date = new Date()): Promise<number> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const overdue = await db
        .select({
          stepId: aiOperatorTaskSteps.id,
          orgId: aiOperatorTaskSteps.orgId,
          taskId: aiOperatorTaskSteps.taskId,
          stepKey: aiOperatorTaskSteps.stepKey,
          ticketId: ticketChecklistItems.ticketId,
          label: ticketChecklistItems.label,
          requesterUserId: aiOperatorTasks.requesterUserId,
        })
        .from(aiOperatorTaskSteps)
        .innerJoin(ticketChecklistItems, and(
          eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId),
          eq(ticketChecklistItems.orgId, aiOperatorTaskSteps.orgId),
        ))
        .innerJoin(aiOperatorTasks, and(
          eq(aiOperatorTasks.id, aiOperatorTaskSteps.taskId),
          eq(aiOperatorTasks.orgId, aiOperatorTaskSteps.orgId),
        ))
        .where(and(
          eq(aiOperatorTaskSteps.stepKind, 'human_work'),
          eq(aiOperatorTaskSteps.state, 'waiting'),
          isNull(aiOperatorTaskSteps.remindedAt),
          isNotNull(aiOperatorTaskSteps.remindAfterAt),
          lte(aiOperatorTaskSteps.remindAfterAt, now),
          isNull(ticketChecklistItems.doneAt),
          eq(aiOperatorTasks.state, 'waiting'),
        ))
        .limit(HUMAN_WORK_REMINDER_SCAN_LIMIT);

      for (const row of overdue) {
        // The stamp is a guarded UPDATE: a concurrent reconciler tick that
        // selected the same row loses here and skips the side-effects, so two
        // ticks cannot both post the comment.
        const stamped = await db
          .update(aiOperatorTaskSteps)
          .set({ remindedAt: now, updatedAt: now })
          .where(and(eq(aiOperatorTaskSteps.id, row.stepId), isNull(aiOperatorTaskSteps.remindedAt)))
          .returning({ id: aiOperatorTaskSteps.id });
        if (stamped.length === 0) continue;

        await db.insert(ticketComments).values({
          ticketId: row.ticketId,
          userId: null,
          portalUserId: null,
          authorName: OPERATOR_TASK_ACTOR.name,
          authorType: 'ai_agent',
          originPrincipalKind: 'ai_agent',
          commentType: 'internal',
          isPublic: false,
          content:
            `This AI Operator task is still waiting on a person for "${row.label}". `
            + 'Tick that checklist step once the work is done and the task will carry on by itself.',
        });

        if (row.requesterUserId) {
          await createNotification({
            userId: row.requesterUserId,
            orgId: row.orgId,
            type: 'ai',
            priority: 'normal',
            title: 'An Operator task is waiting on you',
            message: row.label.slice(0, 500),
            // Relative, same-origin — `user_notifications_link_relative_chk`
            // requires it.
            link: `/tickets/${row.ticketId}`,
            // One reminder per step, ever. The scan's `reminded_at` filter is
            // the first guard; this is the second, and it survives a row that
            // is somehow re-selected after a manual reset.
            dedupeKey: `operator-human-work:${row.stepId}`,
          });
        }

        await appendTaskEvent(db, {
          orgId: row.orgId, taskId: row.taskId,
          eventType: 'wait_entered', actor: { kind: 'reconciler' }, stepKey: row.stepKey,
          detail: `human work overdue; reminder posted on ticket ${row.ticketId}`,
        });
      }

      return overdue.length;
    }));
}
