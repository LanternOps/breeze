import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { setInvoiceAutopayExcluded } from '../../services/autopay/invoiceControls';
import { invoiceActorFrom, handleServiceError } from './invoices';
export const invoiceAutopayRoutes = new Hono();
invoiceAutopayRoutes.use('*', authMiddleware);
invoiceAutopayRoutes.patch('/:id/autopay',
  requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action),
  requireAutopayEnabled(), zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator('json', z.object({ excluded: z.boolean() }).strict()), async c => {
    try {
      const result = await db.transaction(tx => setInvoiceAutopayExcluded(tx, c.req.valid('param').id,
        c.req.valid('json').excluded, invoiceActorFrom(c)));
      return c.json(result, result.status === 'pending' ? 202 : 200);
    } catch (error) { return handleServiceError(c, error); }
  });
