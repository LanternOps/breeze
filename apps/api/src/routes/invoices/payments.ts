import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { recordPaymentSchema } from '@breeze/shared';
import { recordPayment, listPayments, voidPayment } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoicePaymentRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.INVOICES_READ.resource, PERMISSIONS.INVOICES_READ.action);
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const idParam = z.object({ id: z.string().uuid() });
const payParam = z.object({ id: z.string().uuid(), pid: z.string().uuid() });

invoicePaymentRoutes.get('/:id/payments', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await listPayments(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoicePaymentRoutes.post('/:id/payments', scopes, sendPerm, zValidator('param', idParam), zValidator('json', recordPaymentSchema), async (c) => {
  try { return c.json({ data: await recordPayment(c.req.valid('param').id, c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoicePaymentRoutes.delete('/:id/payments/:pid', scopes, sendPerm, zValidator('param', payParam), async (c) => {
  try { return c.json({ data: await voidPayment(c.req.valid('param').pid, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
