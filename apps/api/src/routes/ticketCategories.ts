import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
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
      const data = await db
        .select()
        .from(ticketCategories)
        .where(eq(ticketCategories.partnerId, partnerId))
        .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name));
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
