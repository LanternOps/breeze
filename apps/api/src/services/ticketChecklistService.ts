import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { ticketChecklistItems, type TicketChecklistItemRow } from '../db/schema';
import { aiOperatorTaskSteps } from '../db/schema/aiOperatorTaskGraph';
import {
  assertChecklistItemDeletable,
  onChecklistItemDone,
  onChecklistItemUnticked,
} from './aiOperator/humanWorkService';
import type {
  ChecklistItemCreateInput,
  ChecklistItemPatchInput,
  ChecklistItemSource,
} from '@breeze/shared';

/** `db` or a transaction handle, so the W03 sweep can seed inside its own tx. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ChecklistServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ChecklistServiceError';
  }
}

const notFound = () => new ChecklistServiceError('Not found', 404, 'NOT_FOUND');

/** userId is null for system/sweep writes — the sweep actor is not a users row. */
export interface ChecklistActor {
  userId: string | null;
}

export interface ChecklistItemView {
  id: string;
  ticketId: string;
  label: string;
  detail: string | null;
  position: number;
  done: boolean;
  doneAt: string | null;
  doneByUserId: string | null;
  source: ChecklistItemSource;
  sourceTemplateItemId: string | null;
  /**
   * The AI Operator task behind an `operator_task` item, for the ticket page's
   * "Operator step" badge (recipe spec §6.5, wave E3).
   *
   * NULL when there is no step, or when the step is in a DIFFERENT org — which
   * is what a ticket that has been moved between orgs looks like. The join in
   * `listChecklist` is constrained on org, so the badge degrades to a plain
   * label rather than rendering a link into another tenant. Single-item
   * responses (create/patch) always report null: the link is read from the
   * list, not from a mutation's echo.
   */
  operatorTaskId: string | null;
  createdAt: string;
}

export interface ChecklistSummary {
  items: ChecklistItemView[];
  done: number;
  total: number;
}

const toIso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

function toView(row: TicketChecklistItemRow, operatorTaskId: string | null = null): ChecklistItemView {
  return {
    id: row.id,
    ticketId: row.ticketId,
    label: row.label,
    detail: row.detail,
    position: row.position,
    // `done` is DERIVED from done_at. There is no stored boolean and no stored
    // counter anywhere — a denormalized count is a drift bug waiting for the
    // first bulk delete (spec §4.1).
    done: row.doneAt !== null && row.doneAt !== undefined,
    doneAt: toIso(row.doneAt),
    doneByUserId: row.doneByUserId,
    source: row.source,
    sourceTemplateItemId: row.sourceTemplateItemId,
    operatorTaskId,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

/**
 * Total order: (position, created_at, id). `position` alone is not unique —
 * deliberately, so a whole-list reorder is one statement — so the tie-breakers
 * are what make paging and rendering deterministic.
 *
 * Built LAZILY rather than at module load: #5808 W03 made
 * serviceDeliverableService import this module, which pulls it into module
 * graphs whose suites only PARTIALLY mock `../db/schema`. Touching a schema
 * column at import time turns such a partial mock into a whole-file load
 * failure that names this line rather than the mock (routes/portal.test.ts,
 * routes/portal.compat.test.ts). Nothing is gained by computing it once.
 */
const checklistOrder = () => [
  asc(ticketChecklistItems.position),
  asc(ticketChecklistItems.createdAt),
  asc(ticketChecklistItems.id),
] as const;

export async function listChecklist(
  ticketId: string,
  exec: DbExecutor = db,
): Promise<ChecklistSummary> {
  // LEFT JOIN, and the org predicate is LOAD-BEARING, not tidiness: the step
  // and the item legitimately end up in different orgs after a ticket org-move
  // (the item's org_id is re-stamped, the step's is immutable task history), and
  // the ticket page must not then render a link into the other tenant. The
  // `operator_step_id` column is provenance and is NEVER joined for
  // authorization — this join only decides whether to show a link.
  const rows = (await exec
    .select({
      item: ticketChecklistItems,
      operatorTaskId: aiOperatorTaskSteps.taskId,
    })
    .from(ticketChecklistItems)
    .leftJoin(aiOperatorTaskSteps, and(
      eq(aiOperatorTaskSteps.id, ticketChecklistItems.operatorStepId),
      eq(aiOperatorTaskSteps.orgId, ticketChecklistItems.orgId),
    ))
    .where(eq(ticketChecklistItems.ticketId, ticketId))
    .orderBy(...checklistOrder())) as Array<{ item: TicketChecklistItemRow; operatorTaskId: string | null }>;
  const items = rows.map((r) => toView(r.item, r.operatorTaskId));
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}

export async function getChecklistItemOr404(itemId: string): Promise<TicketChecklistItemRow> {
  const [row] = (await db
    .select()
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.id, itemId))
    .limit(1)) as TicketChecklistItemRow[];
  if (!row) throw notFound();
  return row;
}

/**
 * Whether the item is ticked, read under a row lock (#6930). Callers that must
 * not touch a ticked step (the AI tool refuses to edit or delete one) take the
 * lock so a concurrent human tick cannot land between their check and their
 * write. Inside the request transaction the lock holds until commit. Returns
 * null when the item does not exist.
 */
export async function isChecklistItemTickedForUpdate(itemId: string): Promise<boolean | null> {
  const [row] = (await db
    .select({ doneAt: ticketChecklistItems.doneAt })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.id, itemId))
    .for('update')) as Array<{ doneAt: Date | null }>;
  if (!row) return null;
  return row.doneAt !== null;
}

export async function addChecklistItem(
  ticket: { id: string; orgId: string },
  input: ChecklistItemCreateInput,
  actor: ChecklistActor,
  exec: DbExecutor = db,
): Promise<ChecklistItemView> {
  const [agg] = (await exec
    .select({ maxPosition: sql<number | null>`MAX(${ticketChecklistItems.position})` })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticket.id))) as Array<{ maxPosition: number | null }>;
  const position = (agg?.maxPosition ?? -1) + 1;

  const [row] = (await exec
    .insert(ticketChecklistItems)
    .values({
      // The TICKET's org, never the caller's and never a template's owner.
      orgId: ticket.orgId,
      ticketId: ticket.id,
      label: input.label,
      detail: input.detail ?? null,
      position,
      source: 'manual',
      createdBy: actor.userId,
    })
    .returning()) as TicketChecklistItemRow[];
  if (!row) throw new ChecklistServiceError('Insert failed', 500, 'CHECKLIST_INSERT_FAILED');
  return toView(row);
}

/**
 * The attestation rules live here and nowhere else (spec §4.1).
 *
 * `done_at` / `done_by_user_id` are NEVER read from the patch — the route's Zod
 * schema is `.strict()` and rejects them, and this function derives both from
 * the actor and now().
 */
export async function patchChecklistItem(
  itemId: string,
  patch: ChecklistItemPatchInput,
  actor: ChecklistActor,
): Promise<ChecklistItemView> {
  const existing = await getChecklistItemOr404(itemId);
  const now = new Date();
  const editsText = patch.label !== undefined || patch.detail !== undefined;

  // RULE 1 — ticking is idempotent and FIRST-WRITER-WINS. The guard is
  // `done_at IS NULL`, so a second concurrent tick matches zero rows and the
  // original completer and timestamp survive. A plain unguarded SET would
  // re-attribute a compliance step to whoever clicked second.
  if (patch.done === true && !editsText) {
    const updated = (await db
      .update(ticketChecklistItems)
      .set({ doneAt: now, doneByUserId: actor.userId, updatedAt: now })
      .where(and(eq(ticketChecklistItems.id, itemId), isNull(ticketChecklistItems.doneAt)))
      .returning()) as TicketChecklistItemRow[];
    // THE WAKE (recipe library E3), and only when THIS call is the one that
    // ticked it. `updated[0]` is non-empty exactly when the guarded UPDATE won
    // the first-writer race. A no-op re-tick must NOT wake the task: the
    // transition it would announce did not happen now, and the coordinator
    // would burn a lease claim re-deriving a step it has already settled.
    //
    // `db`, not a new transaction: the request is already one transaction
    // (db/index.ts withDbAccessContext), so the outbox row and the done_at
    // stamp commit together. That atomicity is the whole contract — a wake
    // written after the commit can be lost by a crash, leaving a ticked item
    // and a task that waits until its deadline.
    if (updated[0] && existing.source === 'operator_task') {
      await onChecklistItemDone(db, itemId);
    }
    // Zero rows means it was already done. Re-read so the response is identical
    // either way — ticking twice is a no-op, not a 409.
    return toView(updated[0] ?? (await getChecklistItemOr404(itemId)));
  }

  const set: Partial<typeof ticketChecklistItems.$inferInsert> = { updatedAt: now };
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.detail !== undefined) set.detail = patch.detail;

  // RULE 2 — untick clears BOTH columns, not just the timestamp.
  if (patch.done === false) {
    set.doneAt = null;
    set.doneByUserId = null;
  }

  // RULE 3 — editing the text of a COMPLETED item clears the attestation. The
  // tick attested to the OLD text; carrying it onto new text is a falsified
  // record. Only fires when the row is currently done, so an ordinary typo fix
  // on an unticked step touches neither column.
  //
  // `done: true` ARRIVING WITH a text edit is treated as an edit too: the text
  // changes and the item ends UNTICKED, because the caller cannot attest to
  // text they are changing in the same request. The UI never sends this
  // combination; the rule exists so the API has one answer rather than none.
  if (editsText && (existing.doneAt !== null || patch.done === true)) {
    set.doneAt = null;
    set.doneByUserId = null;
  }

  const [row] = (await db
    .update(ticketChecklistItems)
    .set(set)
    .where(eq(ticketChecklistItems.id, itemId))
    .returning()) as TicketChecklistItemRow[];
  if (!row) throw notFound();

  // RULE 4 (E3) — an untick on an Operator step is RECORDED, never rewound.
  // Spec §6.5. The task may already have dispatched effects against real
  // customer systems on the strength of that tick; "undo" is not available and
  // pretending otherwise would be worse than the stale record. The event row is
  // how a technician later sees that the attestation was withdrawn.
  //
  // Reached by both the explicit `done: false` branch and RULE 3's text-edit
  // clearing, because both end with the item unticked.
  if (existing.source === 'operator_task' && existing.doneAt !== null && row.doneAt === null) {
    await onChecklistItemUnticked(db, itemId);
  }
  return toView(row);
}

/**
 * Whole-list reorder in ONE statement. Two concurrent reorders therefore
 * serialize at the row locks instead of interleaving into a half-order, and a
 * partial or foreign id list is refused before anything is written.
 */
export async function reorderChecklist(
  ticketId: string,
  itemIds: string[],
): Promise<ChecklistSummary> {
  const current = (await db
    .select({ id: ticketChecklistItems.id })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticketId))) as Array<{ id: string }>;

  const currentSet = new Set(current.map((r) => r.id));
  const submitted = new Set(itemIds);
  const sameSet =
    submitted.size === itemIds.length && // no duplicates
    currentSet.size === submitted.size &&
    [...submitted].every((id) => currentSet.has(id));

  if (!sameSet) {
    throw new ChecklistServiceError(
      "The reorder list must contain exactly the ticket's current checklist items, once each",
      400,
      'CHECKLIST_REORDER_MISMATCH',
      { expected: current.length, received: itemIds.length },
    );
  }

  const values = sql.join(
    itemIds.map((id, index) => sql`(${id}::uuid, ${index}::int)`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE ticket_checklist_items AS t
       SET position = v.pos, updated_at = NOW()
      FROM (VALUES ${values}) AS v(id, pos)
     WHERE t.id = v.id AND t.ticket_id = ${ticketId}::uuid
  `);

  return listChecklist(ticketId);
}

export async function deleteChecklistItem(itemId: string): Promise<void> {
  // BEFORE the delete, and it has to be (recipe library E3):
  // `ai_operator_task_steps.checklist_item_id` is ON DELETE SET NULL, so the
  // database would happily accept this and leave a live task waiting on a
  // dependency that no longer exists — a stuck task with no error anywhere.
  // There is nothing for Postgres to raise here; this guard IS the constraint.
  await assertChecklistItemDeletable(itemId, db);

  const deleted = (await db
    .delete(ticketChecklistItems)
    .where(eq(ticketChecklistItems.id, itemId))
    .returning({ id: ticketChecklistItems.id })) as Array<{ id: string }>;
  if (deleted.length === 0) throw notFound();
}

/**
 * One grouped count for many tickets — used by W03's occurrence list so a
 * drawer showing 24 occurrences costs one query, not 24.
 */
export async function checklistCountsForTickets(
  ticketIds: string[],
): Promise<Map<string, { done: number; total: number }>> {
  const out = new Map<string, { done: number; total: number }>();
  if (ticketIds.length === 0) return out;
  const rows = (await db
    .select({
      ticketId: ticketChecklistItems.ticketId,
      total: sql<number>`COUNT(*)::int`,
      done: sql<number>`COUNT(*) FILTER (WHERE ${ticketChecklistItems.doneAt} IS NOT NULL)::int`,
    })
    .from(ticketChecklistItems)
    .where(inArray(ticketChecklistItems.ticketId, ticketIds))
    .groupBy(ticketChecklistItems.ticketId)) as Array<{
    ticketId: string;
    total: number;
    done: number;
  }>;
  for (const r of rows) out.set(r.ticketId, { done: r.done, total: r.total });
  return out;
}
