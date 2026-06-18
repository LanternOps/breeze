import { eq } from 'drizzle-orm';
import { db } from '../db';
import { invoices, invoiceStripePayments } from '../db/schema';
import { getPartnerStripe, getPartnerStripeStatus, PartnerStripeError } from './partnerStripe';
import { toMinorUnits } from './stripeMoney';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { requireOrgAccess } from './invoiceService';

// Statuses whose balance can be collected online. Mirrors the customer-portal
// PAYABLE set (routes/portal/invoices.ts) — drafts/paid/void are excluded.
const PAYABLE = new Set(['sent', 'partially_paid', 'overdue']);

/**
 * Partner-initiated "Send payment link": open a Stripe Checkout session on the
 * partner's OWN Stripe account (using their stored API key — no Connect) for the
 * invoice's outstanding balance and return the hosted-checkout URL. The webhook
 * (routes/webhooks/stripe.ts → stripeReconcile) records the resulting payment
 * idempotently via the `invoice_stripe_payments` mapping, so this only creates
 * the session + a pending mapping row.
 *
 * Twin of the customer-driven POST /portal/invoices/:id/pay. This handler runs
 * under a partner/system request scope, so the partner-axis connection row is
 * RLS-visible directly (no system sub-context escape needed, unlike the portal's
 * org scope).
 */
export async function createInvoicePayLink(invoiceId: string, actor: InvoiceActor): Promise<{ url: string }> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  requireOrgAccess(actor, inv.orgId);
  if (!PAYABLE.has(inv.status)) throw new InvoiceServiceError('Invoice is not payable', 409, 'NOT_PAYABLE');

  // Currency-aware minor units (zero-decimal currencies must not be ×100).
  const balanceMinor = toMinorUnits(inv.balance, inv.currencyCode);
  if (balanceMinor <= 0) throw new InvoiceServiceError('Nothing to pay', 409, 'NOTHING_TO_PAY');

  // The partner charges on their OWN Stripe account using their stored key (no
  // platform/Connect). The discriminated status narrows stripeAccountId to non-null
  // once connected (used for the mapping row).
  const status = await getPartnerStripeStatus(inv.partnerId);
  if (!status.connected) {
    throw new InvoiceServiceError('Online payment is not available — connect Stripe first', 409, 'STRIPE_NOT_CONNECTED');
  }
  let stripe;
  try {
    stripe = await getPartnerStripe(inv.partnerId);
  } catch (err) {
    // Only "no key configured" is a benign 409. A decrypt/unreadable-key fault is an
    // internal error — surface it as such (and let it be logged) instead of lying
    // "connect Stripe first" when the key is actually corrupt/misconfigured.
    if (err instanceof PartnerStripeError && err.code === 'NO_STRIPE_KEY') {
      throw new InvoiceServiceError('Online payment is not available — connect Stripe first', 409, 'STRIPE_NOT_CONNECTED');
    }
    throw new InvoiceServiceError('Could not initialize payment — please contact support', 500, 'STRIPE_INIT_FAILED');
  }

  const portalBase = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || 'http://localhost:4321').replace(/\/$/, '');

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: inv.currencyCode.toLowerCase(),
        unit_amount: balanceMinor,
        product_data: { name: `Invoice ${inv.invoiceNumber ?? inv.id}` },
      },
      quantity: 1,
    }],
    success_url: `${portalBase}/portal/invoices/${inv.id}?paid=1`,
    cancel_url: `${portalBase}/portal/invoices/${inv.id}`,
    metadata: {
      invoice_id: inv.id,
      org_id: inv.orgId,
      partner_id: inv.partnerId,
      invoice_balance_cents: String(balanceMinor),
    },
  }, {
    // Identical (invoice, balance) reuses the session instead of creating a
    // second pending mapping — safe for repeated "send link" clicks.
    idempotencyKey: `inv_${inv.id}_${balanceMinor}`,
  });

  if (!session.url) throw new InvoiceServiceError('Stripe did not return a checkout URL', 500, 'STRIPE_NO_URL');

  await db.insert(invoiceStripePayments).values({
    orgId: inv.orgId,
    invoiceId: inv.id,
    stripeAccountId: status.stripeAccountId,
    stripeObjectType: 'checkout_session',
    stripeObjectId: session.id,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    amount: Number(inv.balance).toFixed(2),
    currency: inv.currencyCode,
    status: 'pending',
  });

  return { url: session.url };
}
