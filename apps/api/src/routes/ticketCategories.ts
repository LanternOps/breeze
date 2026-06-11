import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { ticketCategories, organizations } from '../db/schema';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { ticketCategoryInputSchema } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';

export const ticketCategoriesRoutes = new Hono();

// Apply auth middleware to all routes — requireScope/requirePermission below
// depend on c.get('auth') being populated (same pattern as alerts/index.ts)
ticketCategoriesRoutes.use('*', authMiddleware);

const idParam = z.object({ id: z.string().uuid() });

// GET /ticket-categories — list categories visible to the caller
// RLS is the primary isolation; this adds defense-in-depth app-layer scoping.
ticketCategoriesRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    if (auth.scope === 'partner') {
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
      const data = await db
        .select()
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
      // selectable catalog only — never the MSP's billing defaults
      // (defaultHourlyRate/defaultBillable) or retired categories.
      const data = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db
            .select({
              id: ticketCategories.id,
              name: ticketCategories.name,
              color: ticketCategories.color,
              parentId: ticketCategories.parentId,
              defaultPriority: ticketCategories.defaultPriority,
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
      .select()
      .from(ticketCategories)
      .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name));
    return c.json({ data });
  }
);

// POST /ticket-categories — create; partnerId stamped from auth, never from body
ticketCategoriesRoutes.post(
  '/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
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

    const inserted = await db.insert(ticketCategories).values({
      ...body,
      // numeric column requires string; Drizzle's numeric type maps to string at runtime
      defaultHourlyRate: body.defaultHourlyRate != null ? String(body.defaultHourlyRate) : null,
      partnerId: auth.partnerId
    }).returning();
    return c.json({ data: inserted[0] }, 201);
  }
);

// PATCH /ticket-categories/:id — update; WHERE constrained to auth.partnerId for partner scope
ticketCategoriesRoutes.patch(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', ticketCategoryInputSchema.partial()),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (auth.scope === 'partner' && !auth.partnerId) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

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

    const updated = await db.update(ticketCategories)
      .set({
        ...body,
        defaultHourlyRate: body.defaultHourlyRate != null
          ? String(body.defaultHourlyRate)
          : body.defaultHourlyRate === null ? null : undefined,
        updatedAt: new Date()
      })
      .where(and(...conditions))
      .returning();
    if (!updated[0]) return c.json({ error: 'Category not found' }, 404);
    return c.json({ data: updated[0] });
  }
);

// DELETE /ticket-categories/:id — soft-deactivate; tickets keep their FK
ticketCategoriesRoutes.delete(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
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
      .returning();
    if (!updated[0]) return c.json({ error: 'Category not found' }, 404);
    return c.json({ success: true });
  }
);
