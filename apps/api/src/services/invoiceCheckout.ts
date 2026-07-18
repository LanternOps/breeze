import { eq } from 'drizzle-orm';
import { computeChargeNow } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { invoices, invoiceStripePayments } from '../db/schema';
import { getPartnerStripeClient, PartnerStripeError } from './partnerStripe';
import { toMinorUnits } from './stripeMoney';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { requireOrgAccess, requireSiteAccess } from './invoiceService';
import { portalBase } from './portalUrl';

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
 * Twin of the customer-driven POST /portal/invoices/:id/pay.
 *
 * #1448 — this route opts out of the auth middleware's auto request-transaction
 * (see selfManagedDbContextRoutes.ts), so there is NO ambient DB context here.
 * Each DB step opens its own short `withSystemDbAccessContext` and the slow
 * Stripe HTTP call runs OUTSIDE any transaction — a pooled connection is never
 * held idle across the network round-trip (#1105 class). Tenant isolation does
 * not rely on RLS scope here: the explicit `requireOrgAccess(actor, inv.orgId)`
 * app-layer guard blocks cross-tenant access regardless of the read scope, and
 * the mapping INSERT runs inside a context so it isn't a contextless 0-row
 * no-op (#1375).
 */
export async function createInvoicePayLink(invoiceId: string, actor: InvoiceActor): Promise<{ url: string }> {
  const [inv] = await withSystemDbAccessContext(() =>
    db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  );
  if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  requireOrgAccess(actor, inv.orgId);
  // Site-axis guard: a site-restricted caller must not mint a pay link for an
  // out-of-site invoice. No-op for unrestricted (partner/system/portal) actors.
  requireSiteAccess(actor, inv.siteId);
  if (!PAYABLE.has(inv.status)) throw new InvoiceServiceError('Invoice is not payable', 409, 'NOT_PAYABLE');

  // Deposit-first: charge the deposit remaining while unmet, else the full
  // balance. computeChargeNow clamps to balance and handles every state (no
  // deposit, deposit partially/fully paid) — never reimplement that logic here.
  const chargeNow = computeChargeNow({
    depositDue: inv.depositDue, amountPaid: inv.amountPaid, balance: inv.balance,
  });
  // Currency-aware minor units (zero-decimal currencies must not be ×100).
  const chargeMinor = toMinorUnits(chargeNow.amount, inv.currencyCode);
  if (chargeMinor <= 0) throw new InvoiceServiceError('Nothing to pay', 409, 'NOTHING_TO_PAY');

  // The partner charges on their OWN Stripe account using their stored key (no
  // platform/Connect). stripe_connect_accounts is a partner-axis table (reused by
  // the #1610 API-key model), so read it in a short system-scoped context (#1448 —
  // there is no ambient request tx here). One read returns both the client and the
  // account id (for the mapping row).
  let stripe, stripeAccountId: string;
  try {
    ({ stripe, stripeAccountId } = await withSystemDbAccessContext(() =>
      getPartnerStripeClient(inv.partnerId)));
  } catch (err) {
    // Only "no key configured" is a benign 409. A decrypt/unreadable-key fault is an
    // internal error — surface it as such (and let it be logged) instead of lying
    // "connect Stripe first" when the key is actually corrupt/misconfigured.
    if (err instanceof PartnerStripeError && err.code === 'NO_STRIPE_KEY') {
      throw new InvoiceServiceError('Online payment is not available — connect Stripe first', 409, 'STRIPE_NOT_CONNECTED');
    }
    // Log at this layer too: a non-NO_STRIPE_KEY error here may be an unreadable key
    // (already logged in partnerStripe) OR an unexpected DB/context failure from the
    // wrapping read — don't let the latter collapse into a generic 500 with no trace.
    console.error('[invoiceCheckout] failed to initialize partner Stripe client', { partnerId: inv.partnerId, err });
    throw new InvoiceServiceError('Could not initialize payment — please contact support', 500, 'STRIPE_INIT_FAILED');
  }

  // Shared portal-URL resolution (honors PUBLIC_PORTAL_URL and appends the
  // portal base path to app-origin fallbacks — the /portal segment is no
  // longer hand-appended below).
  const portalBaseUrl = portalBase();

  // Truly outside any DB context/transaction — no pooled connection is held
  // across this ~hundreds-of-ms round trip.
  const session = await runOutsideDbContext(() => stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: inv.currencyCode.toLowerCase(),
        unit_amount: chargeMinor,
        product_data: {
          name: chargeNow.isDeposit
            ? `Deposit — Invoice ${inv.invoiceNumber ?? inv.id}`
            : `Invoice ${inv.invoiceNumber ?? inv.id}`,
        },
      },
      quantity: 1,
    }],
    // {CHECKOUT_SESSION_ID} is substituted by Stripe on redirect — the portal
    // verify-on-return handler reads it to settle server-side (the API-key model
    // has no inbound webhook).
    success_url: `${portalBaseUrl}/invoices/${inv.id}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${portalBaseUrl}/invoices/${inv.id}`,
    metadata: {
      invoice_id: inv.id,
      org_id: inv.orgId,
      partner_id: inv.partnerId,
      // Historically the full balance; now the amount actually charged in THIS
      // session (deposit or balance). Write-only — the settle path (stripeSettle.ts)
      // records what Stripe reports paid via session.amount_total, never this field.
      invoice_balance_cents: String(chargeMinor),
    },
  }, {
    // Identical (invoice, charge-now amount, phase) reuses the session instead of
    // creating a second pending mapping — safe for repeated "send link" clicks. A
    // 50%-deposit invoice has the SAME chargeMinor for the deposit and the later
    // balance charge (different product name but equal amount), so the amount
    // alone can't disambiguate — the explicit dep/bal discriminator does.
    idempotencyKey: `inv_${inv.id}_${chargeMinor}_${chargeNow.isDeposit ? 'dep' : 'bal'}`,
  }));

  if (!session.url) throw new InvoiceServiceError('Stripe did not return a checkout URL', 500, 'STRIPE_NO_URL');

  // Fresh short context so the pending-mapping write isn't a contextless 0-row
  // no-op under forced-RLS breeze_app (#1375).
  await withSystemDbAccessContext(() =>
    db.insert(invoiceStripePayments).values({
      orgId: inv.orgId,
      invoiceId: inv.id,
      stripeAccountId,
      stripeObjectType: 'checkout_session',
      stripeObjectId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      amount: chargeNow.amount,
      currency: inv.currencyCode,
      status: 'pending',
    })
  );

  return { url: session.url };
}
