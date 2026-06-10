import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { tickets, ticketComments, ticketAlertLinks, devices, organizations, users, alerts } from '../../db/schema';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createTicketSchema, updateTicketSchema, changeTicketStatusSchema,
  assignTicketSchema, addTicketCommentSchema, listTicketsQuerySchema
} from '@breeze/shared';
import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  linkAlertToTicket, unlinkAlertFromTicket, createTicketFromAlert,
  TicketServiceError
} from '../../services/ticketService';
import type { AuthContext } from '../../middleware/auth';

export const ticketsRoutes = new Hono();

const idParam = z.object({ id: z.string().uuid() });

const OPEN_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;
const CLOSED_STATUSES = ['resolved', 'closed'] as const;

// Priority weight for triage sort: urgent first.
const PRIORITY_ORDER = sql`CASE ${tickets.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

function actorFrom(c: { get: (k: 'auth') => AuthContext }) {
  const auth = c.get('auth');
  return { userId: auth.user.id, name: auth.user.name, email: auth.user.email };
}

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TicketServiceError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  throw err;
}

// GET /tickets/stats — queue counts for tabs + dashboard widget
// MUST be registered BEFORE GET /:id or 'stats' is captured by the param route.
ticketsRoutes.get(
  '/stats',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const conditions: SQL[] = [];
    if (auth.scope === 'organization' && auth.orgId) conditions.push(eq(tickets.orgId, auth.orgId));
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        status: tickets.status,
        assignedTo: tickets.assignedTo,
        breached: sql<boolean>`(${tickets.slaBreachedAt} IS NOT NULL)`,
        count: sql<number>`count(*)`
      })
      .from(tickets)
      .where(whereCondition)
      .groupBy(tickets.status, tickets.assignedTo, sql`(${tickets.slaBreachedAt} IS NOT NULL)`);

    let open = 0, unassigned = 0, mine = 0, breached = 0;
    for (const r of rows) {
      const n = Number(r.count);
      const isOpen = (OPEN_STATUSES as readonly string[]).includes(r.status as string);
      if (isOpen) {
        open += n;
        if (!r.assignedTo) unassigned += n;
        if (r.assignedTo === auth.user.id) mine += n;
        if (r.breached) breached += n;
      }
    }
    return c.json({ data: { open, unassigned, mine, breached } });
  }
);

// GET /tickets — partner-wide queue
ticketsRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('query', listTicketsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const q = c.req.valid('query');
    const offset = (q.page - 1) * q.limit;

    const conditions: SQL[] = [];
    if (auth.scope === 'organization') {
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      conditions.push(eq(tickets.orgId, auth.orgId));
    }
    if (q.orgId) conditions.push(eq(tickets.orgId, q.orgId));
    if (q.status) conditions.push(eq(tickets.status, q.status));
    else if (q.statusGroup === 'open') conditions.push(inArray(tickets.status, [...OPEN_STATUSES]));
    else if (q.statusGroup === 'closed') conditions.push(inArray(tickets.status, [...CLOSED_STATUSES]));
    if (q.assignee === 'me') conditions.push(eq(tickets.assignedTo, auth.user.id));
    else if (q.assignee === 'unassigned') conditions.push(isNull(tickets.assignedTo));
    else if (q.assignee) conditions.push(eq(tickets.assignedTo, q.assignee));
    if (q.categoryId) conditions.push(eq(tickets.categoryId, q.categoryId));
    if (q.priority) conditions.push(eq(tickets.priority, q.priority));
    if (q.search) {
      const term = `%${q.search}%`;
      const searchCond = or(ilike(tickets.subject, term), ilike(tickets.internalNumber, term));
      if (searchCond) conditions.push(searchCond);
    }
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const orderBy =
      q.sort === 'newest' ? [desc(tickets.createdAt)]
      : q.sort === 'oldest' ? [asc(tickets.createdAt)]
      : q.sort === 'due' ? [asc(tickets.dueDate)]
      : [PRIORITY_ORDER, asc(tickets.createdAt)]; // triage

    const data = await db
      .select({
        id: tickets.id,
        internalNumber: tickets.internalNumber,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        source: tickets.source,
        orgId: tickets.orgId,
        orgName: organizations.name,
        deviceId: tickets.deviceId,
        deviceHostname: devices.hostname,
        assignedTo: tickets.assignedTo,
        assigneeName: users.name,
        categoryId: tickets.categoryId,
        dueDate: tickets.dueDate,
        slaBreachedAt: tickets.slaBreachedAt,
        firstResponseAt: tickets.firstResponseAt,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt
      })
      .from(tickets)
      .leftJoin(organizations, eq(tickets.orgId, organizations.id))
      .leftJoin(devices, eq(tickets.deviceId, devices.id))
      .leftJoin(users, eq(tickets.assignedTo, users.id))
      .where(whereCondition)
      .orderBy(...orderBy)
      .limit(q.limit)
      .offset(offset);

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(tickets)
      .where(whereCondition);
    const total = Number(countRows[0]?.count ?? 0);

    return c.json({ data, pagination: { page: q.page, limit: q.limit, total } });
  }
);

// POST /tickets — manual creation
ticketsRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('json', createTicketSchema),
  async (c) => {
    const body = c.req.valid('json');
    try {
      const ticket = await createTicket({ ...body, source: 'manual' }, actorFrom(c));
      return c.json({ data: ticket }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// GET /tickets/:id — full detail (ticket + comments + alert links)
ticketsRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('param', idParam),
  async (c) => {
    const { id } = c.req.valid('param');

    const ticketRows = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1);
    const ticket = ticketRows[0];
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

    const comments = await db
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, id), isNull(ticketComments.deletedAt)))
      .orderBy(asc(ticketComments.createdAt));

    const alertLinks = await db
      .select({
        id: ticketAlertLinks.id,
        alertId: ticketAlertLinks.alertId,
        linkType: ticketAlertLinks.linkType,
        alertTitle: alerts.title,
        alertSeverity: alerts.severity,
        alertStatus: alerts.status
      })
      .from(ticketAlertLinks)
      .leftJoin(alerts, eq(ticketAlertLinks.alertId, alerts.id))
      .where(eq(ticketAlertLinks.ticketId, id));

    return c.json({ data: { ...ticket, comments, alertLinks } });
  }
);

// PATCH /tickets/:id — field updates (not status/assignee; those have dedicated routes)
ticketsRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', updateTicketSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    if (Object.keys(body).length === 0) return c.json({ error: 'No fields to update' }, 400);

    const updated = await db
      .update(tickets)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(tickets.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: 'Ticket not found' }, 404);
    return c.json({ data: updated[0] });
  }
);

// POST /tickets/:id/status
ticketsRoutes.post(
  '/:id/status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', changeTicketStatusSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const ticket = await changeTicketStatus(id, body.status, {
        resolutionNote: body.resolutionNote,
        pendingReason: body.pendingReason
      }, actorFrom(c));
      return c.json({ data: ticket });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// POST /tickets/:id/assign
ticketsRoutes.post(
  '/:id/assign',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', assignTicketSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { assigneeId } = c.req.valid('json');
    try {
      const ticket = await assignTicket(id, assigneeId, actorFrom(c));
      return c.json({ data: ticket });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// POST /tickets/:id/comments
ticketsRoutes.post(
  '/:id/comments',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', addTicketCommentSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await addTicketComment(id, body, actorFrom(c));
      return c.json({ data: result.comment }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// POST /tickets/:id/alerts — link an alert
ticketsRoutes.post(
  '/:id/alerts',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', z.object({ alertId: z.string().uuid() })),
  async (c) => {
    const { id } = c.req.valid('param');
    const { alertId } = c.req.valid('json');
    try {
      const link = await linkAlertToTicket(id, alertId, actorFrom(c));
      return c.json({ data: link }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// DELETE /tickets/:id/alerts/:alertId
ticketsRoutes.delete(
  '/:id/alerts/:alertId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', z.object({ id: z.string().uuid(), alertId: z.string().uuid() })),
  async (c) => {
    const { id, alertId } = c.req.valid('param');
    try {
      await unlinkAlertFromTicket(id, alertId, actorFrom(c));
      return c.json({ success: true });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
