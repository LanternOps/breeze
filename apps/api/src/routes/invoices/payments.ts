import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { idempotencyKeySchema, recordPaymentSchema } from '@breeze/shared';
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
  // #3803: the idempotency key may come as the conventional Idempotency-Key
  // header or as the body's `idempotencyKey`; both are validated alike, and two
  // that disagree are refused rather than one silently winning.
  const body = c.req.valid('json');
  let idempotencyKey = body.idempotencyKey;
  const headerKey = c.req.header('Idempotency-Key');
  if (headerKey !== undefined) {
    const parsed = idempotencyKeySchema.safeParse(headerKey);
    if (!parsed.success) {
      return c.json({ error: 'Idempotency-Key must be 1-255 visible ASCII characters with no whitespace', code: 'INVALID_IDEMPOTENCY_KEY' }, 400);
    }
    if (idempotencyKey !== undefined && idempotencyKey !== parsed.data) {
      return c.json({ error: 'The Idempotency-Key header and the body idempotencyKey differ', code: 'IDEMPOTENCY_KEY_MISMATCH' }, 400);
    }
    idempotencyKey = parsed.data;
  }
  try {
    const { invoice, audit, replayed } = await recordPayment(c.req.valid('param').id, { ...body, idempotencyKey }, invoiceActorFrom(c));
    // A replay recorded nothing, so it writes no audit entry: the request that
    // recorded the payment wrote that one.
    if (replayed) {
      c.header('Idempotent-Replayed', 'true');
      return c.json({ data: invoice });
    }
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
      details: {
        amount: audit.amount, method: audit.method, reference: audit.reference,
        invoiceId: audit.invoiceId, recordedBy: audit.recordedBy,
        // Only on a QuickBooks-origin void that Breeze was allowed to take
        // because no CDC sweep would re-import it. The QuickBooks Payment is
        // still standing; the service also writes its own durable entry, but a
        // reader of THIS event must not have to go find that one.
        // Persisted audit key — kept byte-identical (refinement 21); details carry no provider-neutral twin.
        ...(audit.providerRecordUntouched
          ? { quickbooksRecordUntouched: true, untouchedReason: audit.untouchedReason }
          : {}),
      }
    });
    const untouched = audit.providerRecordUntouched === true;
    return c.json({ data: invoice, providerRecordUntouched: untouched });
  } catch (err) { return handleServiceError(c, err); }
});
