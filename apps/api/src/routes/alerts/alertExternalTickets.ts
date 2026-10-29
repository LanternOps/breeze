import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { listAlertExternalTickets } from '../../services/alertExternalTickets';
import { getAlertWithOrgCheck } from './helpers';

export const alertExternalTicketRoutes = new Hono();

alertExternalTicketRoutes.get('/:id/external-tickets',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action),
  zValidator('param', z.object({ id: z.string().uuid() })),
  async c => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const alert = await getAlertWithOrgCheck(id, {
      ...auth, allowedSiteIds: c.get('permissions').allowedSiteIds,
    });
    if (!alert) return c.json({ error: 'Alert not found' }, 404);
    return c.json({ data: await listAlertExternalTickets(id, auth.partnerId) });
  },
);
