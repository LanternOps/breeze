// apps/api/src/services/workTypeService.ts
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { workTypes, type WorkType } from '../db/schema/workTypes';
// ticketCategories lives in tickets.ts; ticketConfig.ts holds orgTicketSettings.
import { ticketCategories } from '../db/schema/tickets';
import { isPgUniqueViolation } from '../utils/pgErrors';

export const WORK_TYPE_NAME_MAX = 60;

export class WorkTypeServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'WorkTypeServiceError';
  }
}

/**
 * Every work type for one partner, ordered as the pickers render them.
 * Runs in the caller's AMBIENT RLS context -- work_types is partner-axis and
 * every caller is a partner-scoped request, so the policy is the tenancy check.
 * Never wrap this in withSystemDbAccessContext (CLAUDE.md: that pattern is
 * retired for plain config tables -- it double-holds a pooled connection under
 * the request transaction and bypasses RLS, which is how #2417 shipped).
 */
export async function listWorkTypes(
  partnerId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<WorkType[]> {
  const where = opts.includeInactive
    ? eq(workTypes.partnerId, partnerId)
    : and(eq(workTypes.partnerId, partnerId), eq(workTypes.isActive, true));
  return db.select().from(workTypes).where(where).orderBy(asc(workTypes.sortOrder), asc(workTypes.name));
}

export async function createWorkType(
  partnerId: string,
  input: { name: string; sortOrder?: number },
): Promise<WorkType> {
  try {
    const [row] = await db
      .insert(workTypes)
      .values({ partnerId, name: input.name, sortOrder: input.sortOrder ?? 0 })
      .returning();
    if (!row) throw new Error('Failed to create work type');
    return row;
  } catch (err) {
    // Re-throw, never swallow: the request transaction is already aborted.
    if (isPgUniqueViolation(err)) {
      throw new WorkTypeServiceError('A work type with that name already exists', 409, 'WORK_TYPE_NAME_TAKEN');
    }
    throw err;
  }
}

export async function updateWorkType(
  id: string,
  partnerId: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean },
): Promise<WorkType> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) set.isActive = input.isActive;
  try {
    const [row] = await db
      .update(workTypes)
      .set(set)
      // partnerId is belt-and-braces over the RLS policy: an explicit predicate
      // makes the tenancy visible at the call site and survives a future system
      // -context caller that the policy would not constrain.
      .where(and(eq(workTypes.id, id), eq(workTypes.partnerId, partnerId)))
      .returning();
    if (!row) throw new WorkTypeServiceError('Work type not found', 404, 'WORK_TYPE_NOT_FOUND');
    return row;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new WorkTypeServiceError('A work type with that name already exists', 409, 'WORK_TYPE_NAME_TAKEN');
    }
    throw err;
  }
}

/**
 * Soft delete. A work type is stamped on historical time entries, so it is
 * archived, never removed: a hard DELETE would raise 23503 against the NO
 * ACTION time_entries_work_type_partner_fk, and "fixing" that with SET NULL
 * would silently rewrite billing history.
 *
 * Archiving ALSO clears the row as `ticket_categories.default_work_type_id`
 * across the partner, in the same transaction. Without that, the picker stops
 * offering the work type while the server-side category default goes on
 * stamping it on every new time entry — an archive that visibly did nothing.
 * The count comes back so the UI can say what else changed rather than
 * silently rewriting a technician's category configuration.
 */
export async function archiveWorkType(
  id: string,
  partnerId: string,
): Promise<{ workType: WorkType; clearedCategoryCount: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(workTypes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(workTypes.id, id), eq(workTypes.partnerId, partnerId)))
      .returning();
    if (!row) throw new WorkTypeServiceError('Work type not found', 404, 'WORK_TYPE_NOT_FOUND');

    // partnerId is in the predicate as well as the id: the composite FK means a
    // category can only ever reference a work type of its own partner, but an
    // explicit tenancy predicate keeps that visible at the call site.
    const cleared = await tx
      .update(ticketCategories)
      .set({ defaultWorkTypeId: null, updatedAt: new Date() })
      .where(and(
        eq(ticketCategories.partnerId, partnerId),
        eq(ticketCategories.defaultWorkTypeId, id),
      ))
      .returning({ id: ticketCategories.id });

    return { workType: row, clearedCategoryCount: cleared.length };
  });
}

/**
 * The ACTIVE work type with this id for this partner, or null.
 *
 * THE PRE-WRITE GATE for every caller that stamps `work_type_id`. The composite
 * FK `(work_type_id, partner_id) -> work_types(id, partner_id)` raises 23503,
 * and that violation happens INSIDE the request transaction opened by
 * `withDbAccessContext` -- which aborts it. Every statement after that fails
 * with 25P02, so a catch-and-map-to-400 around the insert is unreachable and
 * the caller gets a raw 500 (the same trap #2189 documented for startTimer's
 * unique index). Validate first; never catch 23503 after the fact.
 *
 * Archived rows are excluded deliberately: an archived work type may stay
 * stamped on historical entries, but nothing new may be stamped with it.
 *
 * Ambient RLS context, like `listWorkTypes` -- see its note.
 */
export async function getActiveWorkType(id: string, partnerId: string): Promise<WorkType | null> {
  const rows = await db
    .select()
    .from(workTypes)
    .where(and(eq(workTypes.id, id), eq(workTypes.partnerId, partnerId), eq(workTypes.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}
