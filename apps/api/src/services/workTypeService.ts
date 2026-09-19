// apps/api/src/services/workTypeService.ts
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { workTypes, type WorkType } from '../db/schema/workTypes';
// ticketCategories lives in tickets.ts; ticketConfig.ts holds orgTicketSettings.
import { ticketCategories } from '../db/schema/tickets';

export const WORK_TYPE_NAME_MAX = 60;

export class WorkTypeServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'WorkTypeServiceError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
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
    if (isUniqueViolation(err)) {
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
    if (isUniqueViolation(err)) {
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
 */
export async function archiveWorkType(id: string, partnerId: string): Promise<WorkType> {
  return updateWorkType(id, partnerId, { isActive: false });
}

/**
 * The category's default work type, or null. Read in the ambient context:
 * ticket_categories is partner-axis and already RLS-protected.
 */
export async function getCategoryDefaultWorkTypeId(categoryId: string): Promise<string | null> {
  const rows = await db
    .select({ defaultWorkTypeId: ticketCategories.defaultWorkTypeId })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, categoryId))
    .limit(1);
  return rows[0]?.defaultWorkTypeId ?? null;
}
