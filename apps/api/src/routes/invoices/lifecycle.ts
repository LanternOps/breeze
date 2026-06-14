import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { voidInvoiceSchema } from '@breeze/shared';
import { issueInvoice, voidInvoice } from '../../services/invoiceService';
import { sendInvoiceEmail } from '../../services/invoicePdf'; // added in Phase 5
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const idParam = z.object({ id: z.string().uuid() });

invoiceLifecycleRoutes.post('/:id/issue', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await issueInvoice(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await sendInvoiceEmail(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceLifecycleRoutes.post('/:id/void', scopes, sendPerm, zValidator('param', idParam), zValidator('json', voidInvoiceSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await voidInvoice(c.req.valid('param').id, b.reason, { reissue: b.reissue }, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
