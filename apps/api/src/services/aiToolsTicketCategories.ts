/**
 * `manage_ticket_config` — the ticket-category actions (full-control W06, #6776).
 *
 * Mirrors routes/ticketCategories.ts, which has NO service layer (the queries
 * are inline in the route), so this file is the tool's twin of that route and
 * keeps its rules one-for-one: partner-wide capability gate, partner derived
 * from the caller (never from input), parent/default-work-type tenant guards
 * (a composite-FK 23503 would abort the request transaction), soft delete.
 * Parity is pinned by the route-binding rows and aiToolsTicketCategories.test.ts.
 * Follow-up (recorded in the W06 plan, D9): extract a shared service so the
 * route and the tool cannot drift.
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ticketCategoryInputSchema } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, ticketCategories } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { getActiveWorkType } from './workTypeService';
import { jsonError, json, parseData, partnerWideDeniedError } from './aiToolsTicketOpsShared';

const categoryProjection = {
  id: ticketCategories.id,
  partnerId: ticketCategories.partnerId,
  name: ticketCategories.name,
  color: ticketCategories.color,
  parentId: ticketCategories.parentId,
  defaultPriority: ticketCategories.defaultPriority,
  responseSlaMinutes: ticketCategories.responseSlaMinutes,
  resolutionSlaMinutes: ticketCategories.resolutionSlaMinutes,
  defaultWorkTypeId: ticketCategories.defaultWorkTypeId,
  defaultTimeEntryMinutes: ticketCategories.defaultTimeEntryMinutes,
  sortOrder: ticketCategories.sortOrder,
  isActive: ticketCategories.isActive,
  createdAt: ticketCategories.createdAt,
  updatedAt: ticketCategories.updatedAt,
};

const reorderSchema = z
  .object({ ids: z.array(z.string().guid()).min(1).max(200) })
  .refine((v) => new Set(v.ids).size === v.ids.length, { message: 'ids must be unique', path: ['ids'] });

const categoryId = z.string().guid();

/** Writes: partner/system scope + full partner access, exactly as `requirePartnerGlobalAccess`. */
function writeGate(auth: AuthContext): string | null {
  if (!canManagePartnerWidePolicies(auth)) return partnerWideDeniedError();
  if (!auth.partnerId) return jsonError('Partner context required', 'ACCESS_DENIED');
  return null;
}

/** Rows for `list_categories`, by scope: the selectable catalog for an org token, the full set otherwise. */
export async function listCategoryRows(auth: AuthContext): Promise<{ rows: unknown[] } | { error: string }> {
  if (auth.scope === 'partner') {
    if (!canManagePartnerWidePolicies(auth)) return { error: partnerWideDeniedError() };
    if (!auth.partnerId) return { error: jsonError('Partner context required', 'ACCESS_DENIED') };
    const rows = await db
      .select(categoryProjection)
      .from(ticketCategories)
      .where(eq(ticketCategories.partnerId, auth.partnerId))
      .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name));
    return { rows };
  }
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: jsonError('Organization context required', 'ACCESS_DENIED') };
    const orgRows = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, auth.orgId))
      .limit(1);
    const partnerId = orgRows[0]?.partnerId;
    if (!partnerId) return { rows: [] };
    // Same as the route: partner-axis RLS hides the table from an org context, so the
    // read runs in system context, filtered by the partner derived from auth.orgId
    // (never from input) and limited to the selectable (active) catalog.
    const rows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({
            id: ticketCategories.id,
            name: ticketCategories.name,
            color: ticketCategories.color,
            parentId: ticketCategories.parentId,
            defaultPriority: ticketCategories.defaultPriority,
            defaultWorkTypeId: ticketCategories.defaultWorkTypeId,
            sortOrder: ticketCategories.sortOrder,
            isActive: ticketCategories.isActive,
          })
          .from(ticketCategories)
          .where(and(eq(ticketCategories.partnerId, partnerId), eq(ticketCategories.isActive, true)))
          .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name)),
      ),
    );
    return { rows };
  }
  const rows = await db
    .select(categoryProjection)
    .from(ticketCategories)
    .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name));
  return { rows };
}

async function invalidDefaultWorkType(defaultWorkTypeId: string | null | undefined, partnerId: string): Promise<string | null> {
  if (defaultWorkTypeId == null) return null;
  return (await getActiveWorkType(defaultWorkTypeId, partnerId)) ? null : 'Default work type not found';
}

async function categoryPartner(id: string): Promise<string | null> {
  const rows = await db
    .select({ partnerId: ticketCategories.partnerId })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, id))
    .limit(1);
  return rows[0]?.partnerId ?? null;
}

export async function createCategory(auth: AuthContext, data: unknown): Promise<string> {
  const denied = writeGate(auth);
  if (denied) return denied;
  const parsed = parseData(ticketCategoryInputSchema, data);
  if ('error' in parsed) return parsed.error;
  const body = parsed.value;
  const partnerId = auth.partnerId!;

  if (body.parentId) {
    const parentRows = await db
      .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
      .from(ticketCategories)
      .where(eq(ticketCategories.id, body.parentId))
      .limit(1);
    if (!parentRows[0] || parentRows[0].partnerId !== partnerId) return jsonError('Parent category not found');
  }
  const workTypeError = await invalidDefaultWorkType(body.defaultWorkTypeId, partnerId);
  if (workTypeError) return jsonError(workTypeError);

  const inserted = await db.insert(ticketCategories).values({ ...body, partnerId }).returning(categoryProjection);
  return json({ category: inserted[0] });
}

export async function updateCategory(auth: AuthContext, id: unknown, data: unknown): Promise<string> {
  const denied = writeGate(auth);
  if (denied) return denied;
  const idParsed = categoryId.safeParse(id);
  if (!idParsed.success) return jsonError('id must be a category UUID', 'VALIDATION_ERROR');
  const parsed = parseData(ticketCategoryInputSchema.partial(), data);
  if ('error' in parsed) return parsed.error;
  const body = parsed.value;
  const catId = idParsed.data;

  // Partner scope: the caller's partner is authoritative. System scope: the target row's.
  let targetPartnerId: string | null = auth.scope === 'partner' ? (auth.partnerId ?? null) : null;
  if (typeof body.parentId === 'string' || body.defaultWorkTypeId != null) {
    if (!targetPartnerId) targetPartnerId = await categoryPartner(catId);
    if (!targetPartnerId) return jsonError('Category not found');
  }
  if (typeof body.parentId === 'string') {
    if (body.parentId === catId) return jsonError('Category cannot be its own parent');
    const parentRows = await db
      .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
      .from(ticketCategories)
      .where(eq(ticketCategories.id, body.parentId))
      .limit(1);
    if (!parentRows[0] || parentRows[0].partnerId !== targetPartnerId) return jsonError('Parent category not found');
  }
  if (body.defaultWorkTypeId != null) {
    const workTypeError = await invalidDefaultWorkType(body.defaultWorkTypeId, targetPartnerId!);
    if (workTypeError) return jsonError(workTypeError);
  }
  if (Object.keys(body).length === 0) return jsonError('update_category needs at least one field in data', 'VALIDATION_ERROR');

  const conditions: SQL[] = [eq(ticketCategories.id, catId)];
  if (auth.scope === 'partner' && auth.partnerId) conditions.push(eq(ticketCategories.partnerId, auth.partnerId));
  const updated = await db
    .update(ticketCategories)
    .set({ ...body, updatedAt: new Date() })
    .where(and(...conditions))
    .returning(categoryProjection);
  if (!updated[0]) return jsonError('Category not found');
  return json({ category: updated[0] });
}

/** Soft deactivate; tickets keep their FK (same as the route). */
export async function deleteCategory(auth: AuthContext, id: unknown): Promise<string> {
  const denied = writeGate(auth);
  if (denied) return denied;
  const idParsed = categoryId.safeParse(id);
  if (!idParsed.success) return jsonError('id must be a category UUID', 'VALIDATION_ERROR');
  const conditions: SQL[] = [eq(ticketCategories.id, idParsed.data)];
  if (auth.scope === 'partner' && auth.partnerId) conditions.push(eq(ticketCategories.partnerId, auth.partnerId));
  const updated = await db
    .update(ticketCategories)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(...conditions))
    .returning(categoryProjection);
  if (!updated[0]) return jsonError('Category not found');
  return json({ category: updated[0], deactivated: true });
}

export async function reorderCategories(auth: AuthContext, ids: unknown): Promise<string> {
  const denied = writeGate(auth);
  if (denied) return denied;
  const parsed = reorderSchema.safeParse({ ids });
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid ids', 'VALIDATION_ERROR');
  const list = parsed.data.ids;

  // Every id must exist and belong to ONE partner (the caller's, for partner scope): no partial reorders.
  const rows = await db
    .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
    .from(ticketCategories)
    .where(inArray(ticketCategories.id, list));
  const partnerIds = new Set(rows.map((r) => r.partnerId));
  const expected = auth.scope === 'partner' ? auth.partnerId : rows[0]?.partnerId;
  if (rows.length !== list.length || partnerIds.size !== 1 || !expected || !partnerIds.has(expected)) {
    return jsonError('One or more categories not found');
  }
  for (const [index, id] of list.entries()) {
    await db.update(ticketCategories).set({ sortOrder: index, updatedAt: new Date() }).where(eq(ticketCategories.id, id));
  }
  return json({ reordered: list.length });
}
