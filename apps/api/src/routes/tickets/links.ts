import { Hono } from 'hono';
import { z } from 'zod';
import { and, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { tickets } from '../../db/schema';
import { createTicketLinkSchema, ERROR_CODES } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  addTicketLink,
  findTicketIdByNumber,
  getTicketLinkForTicket,
  listTicketLinks,
  removeTicketLink,
  TicketLinkError,
} from '../../services/ticketLinkService';
import { actorFrom, getScopedTicketOr404 } from './tickets';
import { ticketSiteScopeCondition } from './siteScope';

/**
 * Ticket-to-ticket links (#7900, feature #8592 W02). Staff-only: no portal
 * route reads ticket_links. Who may link: tickets write permission plus scope
 * on BOTH tickets (approved decision 11) — each ticket is resolved through
 * getScopedTicketOr404 (org/partner access + site axis), and a ticket the
 * caller cannot see is a 404, never a 403, so a link attempt does not reveal
 * that it exists. Same org only (decision 6, enforced again by the schema).
 * No AI tool yet (W04); see mcpCoverage.
 */
export const ticketLinkRoutes = new Hono();

const scopes = requireScope('organization', 'partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

const idParam = z.object({ id: z.string().guid() });
const linkParam = z.object({ id: z.string().guid(), linkId: z.string().guid() });

const notFound = (c: { json: (b: unknown, s: 404) => Response }, what = 'Ticket') =>
  c.json({ error: `${what} not found`, code: ERROR_CODES.NOT_FOUND }, 404);

function handleLinkError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TicketLinkError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
  }
  throw err;
}

/**
 * The same visibility getScopedTicketOr404 applies to one ticket, as a list
 * condition on the counterpart: the site axis, plus the exact-device axis of a
 * device-bound AI run (allowedDeviceIds), which ticketSiteScopeCondition does
 * not cover. Deviceless tickets stay visible on both axes, as there.
 */
function counterpartScope(auth: AuthContext): SQL | undefined {
  const site = ticketSiteScopeCondition(auth);
  const allowed = auth.allowedDeviceIds;
  if (!allowed) return site;
  const device = allowed.length === 0
    ? isNull(tickets.deviceId)
    : or(isNull(tickets.deviceId), inArray(tickets.deviceId, allowed))!;
  return site ? and(site, device) : device;
}

ticketLinkRoutes.get('/:id/links', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
  if (!ticket) return notFound(c);
  // The counterpart passes the same site axis as the ticket itself; links to a
  // ticket the caller cannot see are omitted, not redacted.
  return c.json({ data: await listTicketLinks(ticket.id, { counterpartFilter: counterpartScope(auth) }) });
});

ticketLinkRoutes.post(
  '/:id/links',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', createTicketLinkSchema),
  async (c) => {
    const auth = c.get('auth');
    const source = await getScopedTicketOr404(auth, c.req.valid('param').id);
    if (!source) return notFound(c);
    const body = c.req.valid('json');
    const targetId = body.targetTicketId ?? (await findTicketIdByNumber(source.orgId, body.targetTicketNumber!));
    const target = targetId ? await getScopedTicketOr404(auth, targetId) : null;
    if (!target) return notFound(c);
    try {
      const link = await addTicketLink(
        { source: { id: source.id, orgId: source.orgId }, target: { id: target.id, orgId: target.orgId }, linkType: body.linkType },
        actorFrom(c),
      );
      return c.json({ success: true, data: link }, 201);
    } catch (err) {
      return handleLinkError(c, err);
    }
  },
);

ticketLinkRoutes.delete('/:id/links/:linkId', scopes, writePerm, zValidator('param', linkParam), async (c) => {
  const auth = c.get('auth');
  const { id, linkId } = c.req.valid('param');
  const ticket = await getScopedTicketOr404(auth, id);
  if (!ticket) return notFound(c);
  const link = await getTicketLinkForTicket(ticket.id, linkId);
  // A link whose other ticket the caller cannot see is as invisible here as it
  // is in the list.
  if (!link || !(await getScopedTicketOr404(auth, link.otherTicketId))) return notFound(c, 'Link');
  try {
    await removeTicketLink(ticket.id, linkId, actorFrom(c));
    return c.json({ success: true });
  } catch (err) {
    return handleLinkError(c, err);
  }
});
