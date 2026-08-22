import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission, requireMfa } from '../../middleware/auth';
import { hasPermission, PERMISSIONS } from '../../services/permissions';
import { moveTicketOrgSchema } from '@breeze/shared';
import { moveTicketOrg } from '../../services/ticketService';
import { TicketMoveCurrencyBlockedError } from '../../services/ticketMoveCurrencyGuard';
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
    const { orgId: targetOrgId, acceptCurrencyMismatch } = c.req.valid('json');

    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

    if (!auth.canAccessOrg(targetOrgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }

    // Multi-currency (#3776): accepting that unbilled monetary rows stay in the
    // OLD currency is a billing decision — it needs invoices:write on top of the
    // move's own gates. `permissions` is populated by requirePermission above.
    if (
      acceptCurrencyMismatch === true &&
      !hasPermission(c.get('permissions'), PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action)
    ) {
      return c.json({ error: 'Accepting a currency mismatch requires invoices:write' }, 403);
    }

    try {
      const ticket = await moveTicketOrg(id, targetOrgId, actorFrom(c), {
        acceptCurrencyMismatch: acceptCurrencyMismatch === true,
      });
      return c.json({ data: ticket });
    } catch (err) {
      if (err instanceof TicketMoveCurrencyBlockedError) {
        return c.json({ error: err.message, code: err.code, details: err.details }, 409);
      }
      return handleServiceError(c, err);
    }
  },
);
