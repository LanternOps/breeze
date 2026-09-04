import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  listInvoiceLineDevices,
  INVOICE_LINE_DEVICES_DEFAULT_LIMIT,
  INVOICE_LINE_DEVICES_MAX_LIMIT,
} from '../../services/billingEvidence';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceEvidenceRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.INVOICES_READ.resource, PERMISSIONS.INVOICES_READ.action);
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(INVOICE_LINE_DEVICES_MAX_LIMIT)
    .default(INVOICE_LINE_DEVICES_DEFAULT_LIMIT),
  cursor: z.string().max(512).optional(),
});

// Which devices this invoice line billed. A cross-tenant invoice or a line
// belonging to another invoice is always reported as not found.
invoiceEvidenceRoutes.get(
  '/:id/lines/:lineId/devices',
  scopes,
  readPerm,
  zValidator('param', lineParam),
  zValidator('query', listQuery),
  async (c) => {
    const { id, lineId } = c.req.valid('param');
    const { limit, cursor } = c.req.valid('query');
    try {
      return c.json({
        data: await listInvoiceLineDevices(id, lineId, { limit, cursor }, invoiceActorFrom(c)),
      });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);
