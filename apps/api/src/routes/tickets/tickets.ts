import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { tickets, ticketComments, ticketAlertLinks, devices, organizations, users, alerts } from '../../db/schema';
import { requireScope, requirePermission } from '../../middleware/auth';
import { deviceInSiteScope, ticketSiteScopeCondition } from './siteScope';
import { PERMISSIONS } from '../../services/permissions';
import {
  createTicketSchema, updateTicketSchema, changeTicketStatusSchema,
  assignTicketSchema, addTicketCommentSchema, listTicketsQuerySchema
} from '@breeze/shared';
import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  linkAlertToTicket, unlinkAlertFromTicket, updateTicketFields,
  TicketServiceError
} from '../../services/ticketService';
import type { AuthContext } from '../../middleware/auth';

// NOTE: authMiddleware is applied by the hub router in ./index.ts (alerts pattern) —
// requireScope/requirePermission below depend on c.get('auth') being populated there.
export const ticketsRoutes = new Hono();

const idParam = z.object({ id: z.string().uuid() });

const OPEN_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;
const CLOSED_STATUSES = ['resolved', 'closed'] as const;

// Priority weight for triage sort: urgent first.
const PRIORITY_ORDER = sql`CASE ${tickets.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

// SQL twins of services/ticketSla.ts rules — change them together.
// Active elapsed = now - created_at - paused; at-risk at 80% of the tighter target (D7).
const SLA_BREACHED = sql`${tickets.slaBreachedAt} IS NOT NULL`;
const SLA_AT_RISK = sql`(
  ${tickets.slaBreachedAt} IS NULL
  AND ${tickets.status} IN ('new', 'open')
  AND ${tickets.slaPausedAt} IS NULL
  AND (
    (${tickets.firstResponseAt} IS NULL AND ${tickets.responseSlaMinutes} IS NOT NULL
      AND now() >= ${tickets.createdAt}
        + COALESCE(${tickets.slaPausedMinutes}, 0) * interval '1 minute'
        + ${tickets.responseSlaMinutes} * interval '1 minute' * 0.8)
    OR (${tickets.resolutionSlaMinutes} IS NOT NULL
      AND now() >= ${tickets.createdAt}
        + COALESCE(${tickets.slaPausedMinutes}, 0) * interval '1 minute'
        + ${tickets.resolutionSlaMinutes} * interval '1 minute' * 0.8)
  )
)`;

export function actorFrom(c: { get: (k: 'auth') => AuthContext }) {
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
 * - site axis: device-bound tickets are additionally gated by the caller's
 *   `allowedSiteIds` allowlist (see deviceInSiteScope).
 */
export async function getScopedTicketOr404(
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

  const ticket = rows[0] ?? null;
  if (!ticket) return null;

  // Site-axis restriction (spec §7): a device-bound ticket is visible only when
  // its device's site is in the caller's allowlist. Deviceless (org-level)
  // tickets stay visible — they aren't site-bound (matches alerts semantics).
  if (ticket.deviceId && !(await deviceInSiteScope(auth, ticket.deviceId))) {
    return null;
  }
  return ticket;
}

// Site-axis helpers (deviceInSiteScope, ticketSiteScopeCondition) live in
// ./siteScope so the alerts routes can share them; re-exported here for
// existing consumers (tests pin the tri-state contract via this path).
export { deviceInSiteScope, ticketSiteScopeCondition };

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
    // Site-axis restriction: stats must not leak counts for out-of-site
    // device-bound tickets (deviceless tickets remain counted).
    const siteCondition = ticketSiteScopeCondition(auth);
    if (siteCondition) conditions.push(siteCondition);
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
    const slaRows = await db
      .select({ atRisk: sql<number>`count(*) FILTER (WHERE ${SLA_AT_RISK})` })
      .from(tickets)
      .where(whereCondition);
    const atRisk = Number(slaRows[0]?.atRisk ?? 0);
    return c.json({ data: { open, unassigned, mine, breached, atRisk } });
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
    if (q.deviceId) {
      // Site gate on the explicit device filter (alerts pattern): a restricted
      // caller asking for a device outside their sites gets a hard 403, not an
      // empty list, so the failure is visible.
      if (!(await deviceInSiteScope(auth, q.deviceId))) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      conditions.push(eq(tickets.deviceId, q.deviceId));
    }
    const siteCondition = ticketSiteScopeCondition(auth);
    if (siteCondition) conditions.push(siteCondition);
    if (q.status) conditions.push(eq(tickets.status, q.status));
    else if (q.statusGroup === 'open') conditions.push(inArray(tickets.status, [...OPEN_STATUSES]));
    else if (q.statusGroup === 'closed') conditions.push(inArray(tickets.status, [...CLOSED_STATUSES]));
    if (q.assignee === 'me') conditions.push(eq(tickets.assignedTo, auth.user.id));
    else if (q.assignee === 'unassigned') conditions.push(isNull(tickets.assignedTo));
    else if (q.assignee) conditions.push(eq(tickets.assignedTo, q.assignee));
    if (q.categoryId) conditions.push(eq(tickets.categoryId, q.categoryId));
    if (q.priority) conditions.push(eq(tickets.priority, q.priority));
    if (q.slaState === 'breached') conditions.push(SLA_BREACHED);
    else if (q.slaState === 'at_risk') conditions.push(SLA_AT_RISK);
    else if (q.slaState === 'breaching') conditions.push(sql`(${SLA_BREACHED} OR ${SLA_AT_RISK})`);
    else if (q.slaState === 'ok') conditions.push(sql`(NOT ${SLA_BREACHED} AND NOT ${SLA_AT_RISK})`);
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
      : [desc(SLA_BREACHED), desc(SLA_AT_RISK), PRIORITY_ORDER, asc(tickets.createdAt), asc(tickets.id)]; // triage: breaches surface first

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
        responseSlaMinutes: tickets.responseSlaMinutes,
        resolutionSlaMinutes: tickets.resolutionSlaMinutes,
        slaPausedAt: tickets.slaPausedAt,
        slaPausedMinutes: tickets.slaPausedMinutes,
        slaBreachReason: tickets.slaBreachReason,
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

    // Site-axis guard: a site-restricted caller may only open device-bound
    // tickets for devices in their allowed sites (deviceless org-level tickets
    // are fine — they aren't site-bound).
    if (body.deviceId && !(await deviceInSiteScope(auth, body.deviceId))) {
      return c.json({ error: 'Device not found or access denied' }, 403);
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

// PATCH /tickets/:id — field updates (not status/assignee; those have dedicated routes).
// Delegates to ticketService.updateTicketFields so plain edits produce a system
// feed entry, an audit log, and a ticket.updated lifecycle event. The cross-org
// deviceId guard lives in the service (mirrors createTicket's check).
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
    // zod strips unknown keys, so status/assignee changes sent here would silently
    // vanish — reject them outright and point at the dedicated routes.
    // c.req.json() re-reads Hono's memoized body (zValidator already consumed the
    // stream); if Hono ever stops memoizing, this falls back to null and only the
    // hint is lost, never the 400 itself.
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (raw && 'status' in raw) {
      return c.json({ error: 'Status is not updatable via PATCH — use POST /tickets/:id/status' }, 400);
    }
    if (raw && ('assigneeId' in raw || 'assignedTo' in raw)) {
      return c.json({ error: 'Assignee is not updatable via PATCH — use POST /tickets/:id/assign' }, 400);
    }
    if (Object.keys(body).length === 0) return c.json({ error: 'No fields to update' }, 400);

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

    // Site-axis guard on the NEW device (the existing ticket's device was
    // already gated by getScopedTicketOr404 above).
    if (typeof body.deviceId === 'string' && !(await deviceInSiteScope(auth, body.deviceId))) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }

    try {
      const ticket = await updateTicketFields(id, body, actorFrom(c));
      return c.json({ data: ticket });
    } catch (err) {
      return handleServiceError(c, err);
    }
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

    // Site-axis gate on the ALERT's device (the ticket's device was already
    // gated above): a site-restricted caller must not link alerts for devices
    // outside their allowed sites. The service's same-org check stays in
    // linkAlertToTicket — the route layer owns the site axis.
    const alertRows = await db
      .select({ deviceId: alerts.deviceId })
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .limit(1);
    const alertRow = alertRows[0];
    if (!alertRow) return c.json({ error: 'Alert not found' }, 404);
    if (alertRow.deviceId && !(await deviceInSiteScope(auth, alertRow.deviceId))) {
      // Out-of-site alerts are invisible, not forbidden — same shape as the ticket gate.
      return c.json({ error: 'Alert not found' }, 404);
    }

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

    // Same site-axis gate as the link route: an out-of-site alert must be
    // invisible to a restricted caller even for unlink.
    const alertRows = await db
      .select({ deviceId: alerts.deviceId })
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .limit(1);
    const alertRow = alertRows[0];
    if (!alertRow) return c.json({ error: 'Alert not found' }, 404);
    if (alertRow.deviceId && !(await deviceInSiteScope(auth, alertRow.deviceId))) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    try {
      await unlinkAlertFromTicket(id, alertId, actorFrom(c));
      return c.json({ success: true });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
