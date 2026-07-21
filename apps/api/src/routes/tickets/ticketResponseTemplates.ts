import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, eq, asc } from 'drizzle-orm';
import { db } from '../../db';
import { ticketResponseTemplates } from '../../db/schema';
import { authMiddleware, requireScope, requireMfa, requirePermission } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { canManagePartnerWidePolicies } from '../../services/partnerWideAccess';

export const ticketResponseTemplateRoutes = new Hono();

// This router is mounted at '/' (its routes carry absolute paths), so a
// router-level `.use('*', authMiddleware)` would attach auth to EVERY sibling
// api route — including public ones like /agents/download (the #1383 footgun
// documented in externalServices.ts / invoices/settings.ts). authMiddleware
// must lead each route's own middleware chain instead.
const requireTicketRead = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
// Reuse the tickets-write permission (same admin surface that manages ticket config).
const requireTicketWrite = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

const scopes = requireScope('partner', 'system');
const partnerGlobalDeniedMessage = 'Full partner organization access is required to manage partner-wide ticket response templates';
const requirePartnerGlobalAccess = async (c: Context, next: Next) => {
  if (!canManagePartnerWidePolicies(c.get('auth') as AuthContext)) {
    return c.json({ error: partnerGlobalDeniedMessage }, 403);
  }
  return next();
};

const createSchema = z.object({
  name: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  category: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();
const idParam = z.object({ id: z.string().guid() });

ticketResponseTemplateRoutes.get('/ticket-response-templates', authMiddleware, scopes, requireTicketRead, requirePartnerGlobalAccess, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const partnerId = auth.partnerId;
  if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
  const rows = await db
    .select()
    .from(ticketResponseTemplates)
    .where(and(eq(ticketResponseTemplates.partnerId, partnerId), eq(ticketResponseTemplates.isActive, true)))
    .orderBy(
      asc(ticketResponseTemplates.category),
      asc(ticketResponseTemplates.sortOrder),
      asc(ticketResponseTemplates.name),
    );
  return c.json({ data: rows });
});

ticketResponseTemplateRoutes.post(
  '/ticket-response-templates',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requirePartnerGlobalAccess,
  requireMfa(),
  zValidator('json', createSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const partnerId = auth.partnerId;
    if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
    const data = c.req.valid('json');
    const [row] = await db.insert(ticketResponseTemplates).values({
      partnerId,
      name: data.name.trim(),
      body: data.body,
      category: data.category ?? null,
      sortOrder: data.sortOrder ?? 0,
      isActive: data.isActive ?? true,
      createdBy: auth.user.id ?? null,
    }).returning();
    if (!row) return c.json({ error: 'Failed to create template' }, 500);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_response_template.create',
      resourceType: 'ticket_response_template',
      resourceId: row.id,
      resourceName: row.name,
      details: { partnerId, changedFields: Object.keys(data) },
    });
    return c.json({ data: row }, 201);
  },
);

ticketResponseTemplateRoutes.patch(
  '/ticket-response-templates/:id',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requirePartnerGlobalAccess,
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', updateSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const partnerId = auth.partnerId;
    if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.body !== undefined) patch.body = data.body;
    if (data.category !== undefined) patch.category = data.category;
    if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    const [row] = await db.update(ticketResponseTemplates)
      .set(patch)
      .where(and(eq(ticketResponseTemplates.id, id), eq(ticketResponseTemplates.partnerId, partnerId)))
      .returning();
    if (!row) return c.json({ error: 'Template not found' }, 404);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_response_template.update',
      resourceType: 'ticket_response_template',
      resourceId: row.id,
      resourceName: row.name,
      details: { partnerId, changedFields: Object.keys(data) },
    });
    return c.json({ data: row });
  },
);

ticketResponseTemplateRoutes.delete(
  '/ticket-response-templates/:id',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requirePartnerGlobalAccess,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const partnerId = auth.partnerId;
    if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
    const { id } = c.req.valid('param');
    const [row] = await db.delete(ticketResponseTemplates)
      .where(and(eq(ticketResponseTemplates.id, id), eq(ticketResponseTemplates.partnerId, partnerId)))
      .returning();
    if (!row) return c.json({ error: 'Template not found' }, 404);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_response_template.delete',
      resourceType: 'ticket_response_template',
      resourceId: id,
      resourceName: row.name,
      details: { partnerId, changedFields: ['deleted'] },
    });
    return c.json({ success: true });
  },
);
