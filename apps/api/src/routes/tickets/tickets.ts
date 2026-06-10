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
  linkAlertToTicket, unlinkAlertFromTicket,
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
    return c.json({ error: err.message }, err.status);
  }
  throw err;
}

/**
 * Defense-in-depth app-layer scoping for ticket lookups.
 * RLS is the primary tenant-isolation layer; this adds an explicit WHERE
 * clause matching the house convention from alerts/helpers.ts.
 *
 * Callers must return 403 for a missing context BEFORE calling this function
 * (e.g. organization scope with no orgId). This function returns null → 404
 * as the fallback when the ticket is not visible in the caller's scope.
 *
 * - organization scope: adds eq(orgId); null orgId treated as not-found
 * - partner scope: adds eq(partnerId, auth.partnerId); null partnerId as not-found
 * - system scope: no extra condition (unrestricted)
 */
async function getScopedTicketOr404(
  auth: AuthContext,
  id: string
): Promise<(typeof tickets.$inferSelect) | null> {
  const conditions: SQL[] = [eq(tickets.id, id)];

  if (auth.scope === 'organization') {
    if (!auth.orgId) return null; // 403 callers: treat as not-found for consistency
    conditions.push(eq(tickets.orgId, auth.orgId));
  } else if (auth.scope === 'partner') {
    if (!auth.partnerId) return null;
    conditions.push(eq(tickets.partnerId, auth.partnerId));
  }
  // system scope: no extra condition

  const rows = await db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .limit(1);

  return rows[0] ?? null;
}

/** Sentinel returned by buildScopeConditions when the caller context is broken. */
const SCOPE_MISSING = Symbol('SCOPE_MISSING');

/**
 * Build the scope conditions for bulk queries (stats, list).
 * Returns an array of SQL conditions to splice into a caller's conditions array,
 * or the SCOPE_MISSING sentinel when partner scope lacks a partnerId (broken context).
 * Caller is responsible for checking auth.orgId and returning 403 before calling
 * this when scope === 'organization' and orgId is missing.
 */
function buildScopeConditions(auth: AuthContext): SQL[] | typeof SCOPE_MISSING {
  const conditions: SQL[] = [];
  if (auth.scope === 'organization' && auth.orgId) {
    conditions.push(eq(tickets.orgId, auth.orgId));
  } else if (auth.scope === 'partner') {
    if (!auth.partnerId) return SCOPE_MISSING;
    conditions.push(eq(tickets.partnerId, auth.partnerId));
  }
  return conditions;
}

// GET /tickets/stats — queue counts for tabs + dashboard widget
// MUST be registered BEFORE GET /:id or 'stats' is captured by the param route.
ticketsRoutes.get(
  '/stats',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const scopeResult = buildScopeConditions(auth);
    if (scopeResult === SCOPE_MISSING) {
      return c.json({ error: 'Partner context required' }, 403);
    }
    const conditions: SQL[] = scopeResult;
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
    } else if (auth.scope === 'partner') {
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
      conditions.push(eq(tickets.partnerId, auth.partnerId));
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
      // Escape ILIKE special chars so literal % and _ in the query aren't wildcards.
      const escaped = q.search.replace(/[%_]/g, '\\$&');
      const term = `%${escaped}%`;
      const searchCond = or(ilike(tickets.subject, term), ilike(tickets.internalNumber, term));
      if (searchCond) conditions.push(searchCond);
    }
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const orderBy =
      q.sort === 'newest' ? [desc(tickets.createdAt), desc(tickets.id)]
      : q.sort === 'oldest' ? [asc(tickets.createdAt), asc(tickets.id)]
      : q.sort === 'due' ? [asc(tickets.dueDate), asc(tickets.id)]
      : [PRIORITY_ORDER, asc(tickets.createdAt), asc(tickets.id)]; // triage

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
        resolutionSlaMinutes: tickets.resolutionSlaMinutes,
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
    const auth = c.get('auth');
    const body = c.req.valid('json');

    // Mirror the alerts/rules convention: verify the caller can reach the target org.
    if (!auth.canAccessOrg(body.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

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
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const ticket = await getScopedTicketOr404(auth, id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

    // Decorate with display names for the workbench breadcrumb / assignee chip.
    // Mirrors the list endpoint's join column choices; left joins keep missing
    // device/assignee as null. Strictly additive on top of the raw ticket row.
    const decorationRows = await db
      .select({
        orgName: organizations.name,
        deviceHostname: devices.hostname,
        assigneeName: users.name
      })
      .from(tickets)
      .leftJoin(organizations, eq(tickets.orgId, organizations.id))
      .leftJoin(devices, eq(tickets.deviceId, devices.id))
      .leftJoin(users, eq(tickets.assignedTo, users.id))
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    const { orgName = null, deviceHostname = null, assigneeName = null } = decorationRows[0] ?? {};

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

    return c.json({ data: { ...ticket, orgName, deviceHostname, assigneeName, comments, alertLinks } });
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
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    if (Object.keys(body).length === 0) return c.json({ error: 'No fields to update' }, 400);

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    // Cross-org guard: a deviceId reassignment must reference a device in the
    // ticket's org (mirrors the same-org device check in createTicket).
    if (typeof body.deviceId === 'string') {
      const ticket = await getScopedTicketOr404(auth, id);
      if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
      const deviceRows = await db
        .select({ id: devices.id, orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.id, body.deviceId))
        .limit(1);
      const device = deviceRows[0];
      if (!device) return c.json({ error: 'Device not found' }, 404);
      if (device.orgId !== ticket.orgId) {
        return c.json({ error: 'Device must belong to the same organization as the ticket' }, 400);
      }
    }

    // Build the scoped WHERE for the UPDATE itself so the DB also sees the constraint.
    const updateConditions: SQL[] = [eq(tickets.id, id)];
    if (auth.scope === 'organization' && auth.orgId) {
      updateConditions.push(eq(tickets.orgId, auth.orgId));
    } else if (auth.scope === 'partner' && auth.partnerId) {
      updateConditions.push(eq(tickets.partnerId, auth.partnerId));
    }

    const updated = await db
      .update(tickets)
      .set({ ...body, updatedAt: new Date() })
      .where(and(...updateConditions))
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
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

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
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { assigneeId } = c.req.valid('json');

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

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
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

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
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { alertId } = c.req.valid('json');

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

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
    const auth = c.get('auth');
    const { id, alertId } = c.req.valid('param');

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

    try {
      await unlinkAlertFromTicket(id, alertId, actorFrom(c));
      return c.json({ success: true });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
