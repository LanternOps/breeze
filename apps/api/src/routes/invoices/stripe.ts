import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { createInvoicePayLink } from '../../services/invoiceCheckout';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceStripeRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const idParam = z.object({ id: z.string().uuid() });

// POST /invoices/:id/pay-link — partner-initiated Stripe Checkout link for the
// invoice balance (to share with the customer). Gated on the partner's Stripe
// Connect being active; 409 STRIPE_NOT_CONNECTED otherwise.
invoiceStripeRoutes.post('/:id/pay-link', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await createInvoicePayLink(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
