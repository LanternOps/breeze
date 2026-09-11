import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { invoices } from '../../db/schema';
import { createInvoicePayLink } from '../../services/invoiceCheckout';
import { requireOrgAccess, requireSiteAccess } from '../../services/invoiceService';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { abandonInvoiceSessionRevocation } from '../../services/stripeSessionRevocation';
import { writeRouteAudit } from '../../services/auditEvents';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceStripeRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const billingManagePerm = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const idParam = z.object({ id: z.string().guid() });

// POST /invoices/:id/pay-link — partner-initiated Stripe Checkout link for the
// invoice balance (to share with the customer). Gated on the partner's Stripe
// Connect being active; 409 STRIPE_NOT_CONNECTED otherwise.
invoiceStripeRoutes.post('/:id/pay-link', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await createInvoicePayLink(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});

/**
 * A free-text reason is REQUIRED. Abandoning is a deliberate acceptance that a
 * Checkout session may still be payable on Stripe while Breeze proceeds as if it
 * were not; the record of why has to survive the person who did it.
 */
const abandonSchema = z.object({
  reason: z.string().trim().min(10, 'Explain why these payment links cannot be revoked (at least 10 characters).').max(500),
});

/**
 * POST /invoices/:id/stripe-sessions/abandon — SEC-150 operator override.
 *
 * An MSP whose Stripe account is gone forever (closed, credential destroyed,
 * key permanently revoked) can otherwise never void the invoice: the fail-closed
 * transitions will refuse until the sessions are provably dead, and they never
 * can be. This marks them `revocation_blocked` with an `operator_abandoned`
 * reason, which the transition gate accepts.
 *
 * Deliberately NOT the invoices:send permission the other routes here use —
 * accepting residual payment exposure is a billing decision, so it takes
 * `billing:manage`, an explicit reason, and an audit row every time.
 */
invoiceStripeRoutes.post(
  '/:id/stripe-sessions/abandon',
  scopes,
  billingManagePerm,
  zValidator('param', idParam),
  zValidator('json', abandonSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const actor = invoiceActorFrom(c);
    try {
      const [inv] = await db.select({ id: invoices.id, orgId: invoices.orgId, siteId: invoices.siteId })
        .from(invoices).where(eq(invoices.id, id)).limit(1);
      if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
      requireOrgAccess(actor, inv.orgId);
      requireSiteAccess(actor, inv.siteId);

      const result = await abandonInvoiceSessionRevocation({
        invoiceId: inv.id, reason, actorUserId: actor.userId,
      });
      writeRouteAudit(c, {
        orgId: inv.orgId,
        action: 'invoice.stripe_session_abandoned',
        resourceType: 'invoice',
        resourceId: inv.id,
        result: 'success',
        details: { reason, sessionCount: result.abandoned },
      });
      return c.json({ data: { abandoned: result.abandoned } });
    } catch (err) { return handleServiceError(c, err); }
  },
);
