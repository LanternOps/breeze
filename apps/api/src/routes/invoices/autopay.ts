import { parseAutopayTerms } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { invoices, invoiceAutopaySchedules } from '../../db/schema';
import { requireInvoiceAccess } from '../../services/invoiceService';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { attemptCollection } from '../../services/autopay/collectionEngine';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, withAuthDbAccessContext } from '../../middleware/auth';
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

invoiceAutopayRoutes.post('/:id/autopay/charge-now',
  requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action),
  requireAutopayEnabled(), zValidator('param', z.object({ id: z.string().uuid() })), async c => {
    try {
      const actor = invoiceActorFrom(c);
      const invoiceId = c.req.valid('param').id;
      const scheduleId = await withAuthDbAccessContext(c.get('auth'), async () => {
        const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
        if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
        requireInvoiceAccess(actor, invoice);
        const [schedule] = await db.select().from(invoiceAutopaySchedules)
          .where(eq(invoiceAutopaySchedules.invoiceId, invoice.id)).limit(1);
        if (!schedule?.eligible) throw new InvoiceServiceError('Invoice has no eligible notice', 409, 'INVALID_STATE');
        // Reject before Checkout revocation or any provider call. The locked
        // collection service rechecks the authoritative notice and all fences.
        const lead = parseAutopayTerms(schedule.termsSnapshot).noticeLeadDays;
        if (!schedule.noticeOutboxId || !schedule.noticeSentAt || (lead !== 1 && lead !== 10)
          || Date.now() < schedule.noticeSentAt.getTime() + lead * 86_400_000) {
          throw new InvoiceServiceError('notice_lead', 409, 'INVALID_STATE');
        }
        return schedule.id;
      });
      const result = await attemptCollection({ invoiceId, scheduleId, initiatedBy: 'msp_charge_now' });
      if (result.outcome !== 'created') return c.json({ error: result.reason, code: result.reason }, 409);
      return c.json({ data: result });
    } catch (error) { return handleServiceError(c, error); }
  });
