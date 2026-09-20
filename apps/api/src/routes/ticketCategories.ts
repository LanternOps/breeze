import { Hono, type Context, type Next } from 'hono';
import { zValidator } from '../lib/validation';
import { legacyBillingDeprecationWarnings } from '../lib/legacyBillingDeprecation';
import { z } from 'zod';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { ticketCategories, organizations } from '../db/schema';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { ticketCategoryInputSchema } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { getActiveWorkType } from '../services/workTypeService';
import { writeRouteAudit } from '../services/auditEvents';

export const ticketCategoriesRoutes = new Hono();

// Apply auth middleware to all routes — requireScope/requirePermission below
// depend on c.get('auth') being populated (same pattern as alerts/index.ts)
ticketCategoriesRoutes.use('*', authMiddleware);

const idParam = z.object({ id: z.string().guid() });
const partnerGlobalDeniedMessage = 'Full partner organization access is required to manage partner-wide ticket categories';

const requirePartnerGlobalAccess = async (c: Context, next: Next) => {
  if (!canManagePartnerWidePolicies(c.get('auth') as AuthContext)) {
    return c.json({ error: partnerGlobalDeniedMessage }, 403);
  }
  return next();
};

/**
 * Tenant guard for the category's default work type, mirroring the parentId
 * guard above: `(default_work_type_id, partner_id) -> work_types(id, partner_id)`
 * is a composite FK, and a 23503 from it fires INSIDE the request transaction —
 * which aborts it, so nothing downstream can turn that into a clean 400. An
 * archived work type is refused too: it may stay stamped on history, but it
 * must not become the default for new entries.
 *
 * Returns an error message, or null when there is nothing to check (`undefined`
 * = field omitted, `null` = explicitly cleared).
 */
async function invalidDefaultWorkType(
  defaultWorkTypeId: string | null | undefined,
  partnerId: string,
): Promise<string | null> {
  if (defaultWorkTypeId == null) return null;
  return (await getActiveWorkType(defaultWorkTypeId, partnerId))
    ? null
    : 'Default work type not found';
}

// Explicit projection: legacy pricing columns remain in storage until W04.
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

// GET /ticket-categories — list categories visible to the caller
// RLS is the primary isolation; this adds defense-in-depth app-layer scoping.
ticketCategoriesRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    if (auth.scope === 'partner') {
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: partnerGlobalDeniedMessage }, 403);
      }
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
      const data = await db
        .select(categoryProjection)
        .from(ticketCategories)
        .where(eq(ticketCategories.partnerId, auth.partnerId))
        .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name));
      return c.json({ data });
    }

    if (auth.scope === 'organization') {
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      // Resolve this org's partner to scope the category list.
      const orgRows = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, auth.orgId))
        .limit(1);
      const partnerId = orgRows[0]?.partnerId;
      if (!partnerId) return c.json({ data: [] });
      // The org→partner resolution above stays in the request context (RLS lets an
      // org user read their own org row). The category read runs in a system DB
      // context: ticket_categories is partner-axis RLS, invisible to org-scoped
      // request contexts. The explicit partnerId filter — derived from auth.orgId,
      // never from caller input — is the security boundary, same pattern as
      // ticketService.assertCategoryInPartner. Org users get read-only visibility
      // of their MSP's categories; the write routes below remain partner/system.
      // The column projection + isActive filter are deliberate: org users get the
      // selectable catalog only, excluding retired categories.
      const data = await runOutsideDbContext(() =>
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
              isActive: ticketCategories.isActive
            })
            .from(ticketCategories)
            .where(and(eq(ticketCategories.partnerId, partnerId), eq(ticketCategories.isActive, true)))
            .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name))
        )
      );
      return c.json({ data });
    }

    // system scope: unrestricted
    const data = await db
      .select(categoryProjection)
      .from(ticketCategories)
      .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name));
    return c.json({ data });
  }
);

const reorderSchema = z.object({
  ids: z.array(z.string().guid()).min(1).max(200)
}).refine((v) => new Set(v.ids).size === v.ids.length, {
  message: 'ids must be unique',
  path: ['ids']
});

// PUT /ticket-categories/reorder — assign sortOrder by array position.
// Bulk (not per-row swaps): pre-existing rows all tie at sortOrder=0, so
// swapping tied values is a no-op, and paired PATCHes aren't atomic. The
// client sends one sibling group's ids in their new order; the endpoint is
// hierarchy-agnostic, so "ids form a complete sibling group" is a client-owned
// invariant — a partial subset just gets rebased to ranks 0..n-1 (cosmetic
// only). withDbAccessContext (db/index.ts) wraps the request in a transaction,
// so the sequential updates commit atomically; if that wrapper ever stops
// being transactional, this loop needs its own db.transaction.
ticketCategoriesRoutes.put(
  '/reorder',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  requirePartnerGlobalAccess,
  zValidator('json', reorderSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (auth.scope === 'partner' && !auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    const { ids } = c.req.valid('json');

    // Every id must exist and belong to ONE partner — the caller's for partner
    // scope. Reject wholesale otherwise: no partial reorders.
    const rows = await db
      .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
      .from(ticketCategories)
      .where(inArray(ticketCategories.id, ids));
    const partnerIds = new Set(rows.map((r) => r.partnerId));
    const expectedPartner = auth.scope === 'partner' ? auth.partnerId : rows[0]?.partnerId;
    if (rows.length !== ids.length || partnerIds.size !== 1 || !expectedPartner || !partnerIds.has(expectedPartner)) {
      return c.json({ error: 'One or more categories not found' }, 404);
    }

    for (const [index, id] of ids.entries()) {
      await db.update(ticketCategories)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(eq(ticketCategories.id, id));
    }
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_category.reorder',
      resourceType: 'ticket_category',
      resourceId: expectedPartner,
      resourceName: 'Ticket category order',
      details: { partnerId: expectedPartner, categoryIds: ids, changedFields: ['sortOrder'] }
    });
    return c.json({ success: true });
  }
);

// POST /ticket-categories — create; partnerId stamped from auth, never from body
ticketCategoriesRoutes.post(
  '/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  requirePartnerGlobalAccess,
  zValidator('json', ticketCategoryInputSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (auth.scope === 'partner' && !auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    if (!auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    const body = c.req.valid('json');
    const deprecationWarnings = legacyBillingDeprecationWarnings(await c.req.json());

    // Tenant guard: a parent category must exist within the same partner.
    // The DB composite FK (parent_id, partner_id) backs this; checking here
    // returns a clean 400 instead of a constraint-violation 500.
    if (body.parentId) {
      const parentRows = await db
        .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, body.parentId))
        .limit(1);
      const parent = parentRows[0];
      if (!parent || parent.partnerId !== auth.partnerId) {
        return c.json({ error: 'Parent category not found' }, 400);
      }
    }

    const workTypeError = await invalidDefaultWorkType(body.defaultWorkTypeId, auth.partnerId);
    if (workTypeError) return c.json({ error: workTypeError }, 400);

    const inserted = await db.insert(ticketCategories).values({
      ...body,
      partnerId: auth.partnerId
    }).returning(categoryProjection);
    const row = inserted[0]!;
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_category.create',
      resourceType: 'ticket_category',
      resourceId: row.id,
      resourceName: row.name,
      details: { partnerId: auth.partnerId, changedFields: Object.keys(body) }
    });
    return c.json({ data: row, ...(deprecationWarnings.length ? { deprecationWarnings } : {}) }, 201);
  }
);

// PATCH /ticket-categories/:id — update; WHERE constrained to auth.partnerId for partner scope
ticketCategoriesRoutes.patch(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  requirePartnerGlobalAccess,
  zValidator('param', idParam),
  zValidator('json', ticketCategoryInputSchema.partial()),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (auth.scope === 'partner' && !auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const deprecationWarnings = legacyBillingDeprecationWarnings(await c.req.json());

    if (typeof body.parentId === 'string') {
      if (body.parentId === id) {
        return c.json({ error: 'Category cannot be its own parent' }, 400);
      }
      // Partner scope: the caller's partner is authoritative. System scope:
      // resolve the target category's partner and validate against that.
      let targetPartnerId: string | null = auth.scope === 'partner' ? (auth.partnerId ?? null) : null;
      if (!targetPartnerId) {
        const catRows = await db
          .select({ partnerId: ticketCategories.partnerId })
          .from(ticketCategories)
          .where(eq(ticketCategories.id, id))
          .limit(1);
        targetPartnerId = catRows[0]?.partnerId ?? null;
        if (!targetPartnerId) return c.json({ error: 'Category not found' }, 404);
      }
      const parentRows = await db
        .select({ id: ticketCategories.id, partnerId: ticketCategories.partnerId })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, body.parentId))
        .limit(1);
      const parent = parentRows[0];
      if (!parent || parent.partnerId !== targetPartnerId) {
        return c.json({ error: 'Parent category not found' }, 400);
      }
    }

    const conditions: SQL[] = [eq(ticketCategories.id, id)];
    if (auth.scope === 'partner' && auth.partnerId) {
      conditions.push(eq(ticketCategories.partnerId, auth.partnerId));
    }

    if (body.defaultWorkTypeId != null) {
      // Partner scope: the caller's partner is authoritative. System scope:
      // resolve the target category's partner first (same shape as parentId).
      let targetPartnerId: string | null = auth.scope === 'partner' ? (auth.partnerId ?? null) : null;
      if (!targetPartnerId) {
        const catRows = await db
          .select({ partnerId: ticketCategories.partnerId })
          .from(ticketCategories)
          .where(eq(ticketCategories.id, id))
          .limit(1);
        targetPartnerId = catRows[0]?.partnerId ?? null;
        if (!targetPartnerId) return c.json({ error: 'Category not found' }, 404);
      }
      const workTypeError = await invalidDefaultWorkType(body.defaultWorkTypeId, targetPartnerId);
      if (workTypeError) return c.json({ error: workTypeError }, 400);
    }

    const set = { ...body, updatedAt: new Date() };

    const updated = await db.update(ticketCategories)
      .set(set)
      .where(and(...conditions))
      .returning(categoryProjection);
    if (!updated[0]) return c.json({ error: 'Category not found' }, 404);
    const row = updated[0];
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_category.update',
      resourceType: 'ticket_category',
      resourceId: row.id,
      resourceName: row.name,
      details: { partnerId: row.partnerId, changedFields: Object.keys(body) }
    });
    return c.json({ data: row, ...(deprecationWarnings.length ? { deprecationWarnings } : {}) });
  }
);

// DELETE /ticket-categories/:id — soft-deactivate; tickets keep their FK
ticketCategoriesRoutes.delete(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  requirePartnerGlobalAccess,
  zValidator('param', idParam),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (auth.scope === 'partner' && !auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    const { id } = c.req.valid('param');

    const conditions: SQL[] = [eq(ticketCategories.id, id)];
    if (auth.scope === 'partner' && auth.partnerId) {
      conditions.push(eq(ticketCategories.partnerId, auth.partnerId));
    }

    const updated = await db.update(ticketCategories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(...conditions))
      .returning(categoryProjection);
    if (!updated[0]) return c.json({ error: 'Category not found' }, 404);
    const row = updated[0];
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_category.delete',
      resourceType: 'ticket_category',
      resourceId: row.id,
      resourceName: row.name,
      details: { partnerId: row.partnerId, changedFields: ['isActive'] }
    });
    return c.json({ success: true });
  }
);
