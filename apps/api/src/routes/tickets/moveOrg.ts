import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission, requireMfa } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { moveTicketOrgSchema } from '@breeze/shared';
import { moveTicketOrg } from '../../services/ticketService';
import { getScopedTicketOr404, actorFrom, handleServiceError } from './tickets';

const idParam = z.object({ id: z.string().guid() });

export const ticketMoveOrgRoutes = new Hono();

// POST /tickets/:id/move-org — reassign a ticket to another org of the SAME partner.
// High-privilege: tickets:write + organizations:write at partner/system scope + MFA
// (mirrors devices/moveOrg.ts). Same-partner validation + child org_id re-stamp in the service.
ticketMoveOrgRoutes.post(
  '/:id/move-org',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', moveTicketOrgSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { orgId: targetOrgId } = c.req.valid('json');

    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

    if (!auth.canAccessOrg(targetOrgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }

    try {
      const ticket = await moveTicketOrg(id, targetOrgId, actorFrom(c));
      return c.json({ data: ticket });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);
