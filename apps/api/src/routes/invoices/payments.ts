import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { recordPaymentSchema } from '@breeze/shared';
import { recordPayment, listPayments, voidPayment } from '../../services/invoiceService';
import { writeRouteAudit } from '../../services/auditEvents';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoicePaymentRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.INVOICES_READ.resource, PERMISSIONS.INVOICES_READ.action);
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const idParam = z.object({ id: z.string().guid() });
const payParam = z.object({ id: z.string().guid(), pid: z.string().guid() });

invoicePaymentRoutes.get('/:id/payments', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await listPayments(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoicePaymentRoutes.post('/:id/payments', scopes, sendPerm, zValidator('param', idParam), zValidator('json', recordPaymentSchema), async (c) => {
  try {
    const { invoice, audit } = await recordPayment(c.req.valid('param').id, c.req.valid('json'), invoiceActorFrom(c));
    writeRouteAudit(c, {
      orgId: audit.orgId,
      action: 'invoice.payment.recorded',
      resourceType: 'invoice_payment',
      resourceId: audit.paymentId,
      details: { amount: audit.amount, method: audit.method, reference: audit.reference, invoiceId: audit.invoiceId }
    });
    return c.json({ data: invoice });
  } catch (err) { return handleServiceError(c, err); }
});
invoicePaymentRoutes.delete('/:id/payments/:pid', scopes, sendPerm, zValidator('param', payParam), async (c) => {
  try {
    const { invoice, audit } = await voidPayment(c.req.valid('param').pid, invoiceActorFrom(c));
    // The financial details were captured before the row was destroyed, so the
    // voided payment (incl. who recorded it) survives in the durable chain.
    writeRouteAudit(c, {
      orgId: audit.orgId,
      action: 'invoice.payment.voided',
      resourceType: 'invoice_payment',
      resourceId: audit.paymentId,
      details: { amount: audit.amount, method: audit.method, reference: audit.reference, invoiceId: audit.invoiceId, recordedBy: audit.recordedBy }
    });
    return c.json({ data: invoice });
  } catch (err) { return handleServiceError(c, err); }
});
