import { Hono } from 'hono';
import { z } from 'zod';
import { createTicketLinkSchema, ERROR_CODES } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import {
  addTicketLink,
  findTicketIdByNumber,
  getTicketLinkForTicket,
  listTicketLinks,
  removeTicketLink,
  TicketLinkError,
} from '../../services/ticketLinkService';
import { actorFrom, getScopedTicketOr404 } from './tickets';
import { ticketCounterpartScopeCondition } from './siteScope';

/**
 * Ticket-to-ticket links (#7900, feature #8592 W02). Staff-only: no portal
 * route reads ticket_links. Who may link: tickets write permission plus scope
 * on BOTH tickets (approved decision 11) — each ticket is resolved through
 * getScopedTicketOr404 (org/partner access + site axis), and a ticket the
 * caller cannot see is a 404, never a 403, so a link attempt does not reveal
 * that it exists. Same org only (decision 6, enforced again by the schema).
 * AI surface: manage_tickets list_links / link_ticket / unlink_ticket (W04).
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

ticketLinkRoutes.get('/:id/links', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
  if (!ticket) return notFound(c);
  // The counterpart passes the same site axis as the ticket itself; links to a
  // ticket the caller cannot see are omitted, not redacted.
  // A trashed counterpart's subject is manager-only (#8747); set by readPerm.
  const perms = c.get('permissions') as UserPermissions | undefined;
  const canManage = perms ? hasPermission(perms, PERMISSIONS.TICKETS_MANAGE.resource, PERMISSIONS.TICKETS_MANAGE.action) : false;
  return c.json({ data: await listTicketLinks(ticket.id, { counterpartFilter: ticketCounterpartScopeCondition(auth), canManage }) });
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
  // is in the list. A soft-deleted counterpart is still resolved (#8679): the
  // list shows it, and it must stay removable; org and site scope still apply.
  if (!link || !(await getScopedTicketOr404(auth, link.otherTicketId, { includeDeleted: true }))) {
    return notFound(c, 'Link');
  }
  try {
    await removeTicketLink(ticket.id, linkId, actorFrom(c));
    return c.json({ success: true });
  } catch (err) {
    return handleLinkError(c, err);
  }
});
