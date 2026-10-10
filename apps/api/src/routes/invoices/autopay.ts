import { parseAutopayTerms } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { invoices, invoiceAutopaySchedules } from '../../db/schema';
import { requireInvoiceAccess } from '../../services/invoiceService';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { attemptCollection } from '../../services/autopay/collectionEngine';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireInteractiveSession, requireMfa, requirePermission, withAuthDbAccessContext } from '../../middleware/auth';
import { autopayChargeNowResourceDigest } from '../../services/mfaStepUpGrant';
import { requireBillingStepUp } from '../billingStepUp';
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

// The body is optional: the first request carries none, the resubmit after a
// second-factor confirmation carries the grant.
const chargeNowBody = z.object({ stepUpGrant: z.string().uuid().optional() }).strict();
/**
 * Charge now: starts and confirms an off-session payment for one invoice.
 * A person in an interactive session with a satisfied second factor only, and
 * (two-factor authentication enabled) a fresh `autopay_charge_now` step-up
 * bound to this invoice, consumed after the read-only checks below and before
 * any provider call.
 */
invoiceAutopayRoutes.post('/:id/autopay/charge-now',
  requireInteractiveSession(), requireMfa(),
  requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action),
  requireAutopayEnabled(), zValidator('param', z.object({ id: z.string().uuid() })), async c => {
    try {
      const raw = await c.req.text();
      let parsedBody: unknown = {};
      if (raw.trim() !== '') {
        try { parsedBody = JSON.parse(raw); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
      }
      const body = chargeNowBody.safeParse(parsedBody);
      if (!body.success) return c.json({ error: 'Invalid request body' }, 400);
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
      const refusal = await requireBillingStepUp(c, { operation: 'autopay_charge_now', resource: { invoiceId },
        resourceDigest: autopayChargeNowResourceDigest({ invoiceId }), grant: body.data.stepUpGrant });
      if (refusal) return refusal;
      const result = await attemptCollection({ invoiceId, scheduleId, initiatedBy: 'msp_charge_now' });
      // outcome tells staff whether a payment was attempted (failed / requires_action)
      // or never started (deferred / refused); reason alone cannot.
      if (result.outcome !== 'created') return c.json({ error: result.reason, code: result.reason, outcome: result.outcome }, 409);
      return c.json({ data: result });
    } catch (error) { return handleServiceError(c, error); }
  });
