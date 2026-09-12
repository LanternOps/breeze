import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { getPartnerStripeClient } from './partnerStripe';
import { recordStripePayment } from './stripeReconcile';
import { fromMinorUnits } from './stripeMoney';
import { markSessionChargedRepair } from './stripeSessionRevocation';

/**
 * Settlement primitive for the API-key model (replaces the inbound webhook):
 * retrieve a Checkout session server-side using the PARTNER'S key and, if it's
 * paid, record the payment into the invoice engine via recordStripePayment
 * (idempotent — safe to call repeatedly / from both the return flow and the sweep).
 *
 * Server→Stripe retrieval is trustworthy (NOT a client-trust redirect): we ask
 * Stripe directly whether the session is paid. Returns { settled:false } for an
 * unpaid/incomplete session so callers can no-op.
 *
 * The CALLER establishes the DB context — both callers run system-scoped: the
 * verify-on-return route wraps this in runOutsideDbContext(withSystemDbAccessContext)
 * (the portal is org-scoped and can't read the partner-axis key row directly), and
 * the reconcile sweep runs under the system worker context.
 */
export async function settleCheckoutSession(
  partnerId: string,
  sessionId: string,
): Promise<{ settled: boolean; invoiceId?: string }> {
  const { stripe, stripeAccountId } = await getPartnerStripeClient(partnerId);
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  // A completed session isn't necessarily paid (async methods settle later); only
  // record once Stripe says payment_status='paid'.
  if (session.payment_status !== 'paid') return { settled: false };

  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : String(session.payment_intent ?? '');
  const amountCents = Number(session.amount_total ?? 0);
  const currency = String(session.currency ?? 'usd').toUpperCase();
  if (!paymentIntentId || amountCents <= 0) return { settled: false };

  const res = await recordStripePayment({
    stripeObjectId: session.id,
    stripePaymentIntentId: paymentIntentId,
    stripeAccountId,
    amount: fromMinorUnits(amountCents, currency),
    currency,
  });

  // SEC-150 charged-repair detection, AFTER the capture.
  //
  // Provider truth wins: a session we asked to die that Stripe nonetheless
  // reports PAID is still recorded (never discard a real charge to satisfy a
  // local flag), and the mapping is then parked for a human.
  //
  // Deliberately after `recordStripePayment`, not before. This runs on the
  // caller's transaction, and `recordStripePayment` takes the invoice row
  // `FOR UPDATE` first (B10 lock order, shared by every payment writer).
  // Touching `invoice_stripe_payments` beforehand inverted that order against
  // `recordRevocationIntent`, which locks invoice-then-mapping — a customer
  // returning from Checkout while an operator voids the same invoice is exactly
  // the scenario this feature exists for, and it would have deadlocked (40P01).
  const [mapping] = await db.select({
    revocationState: invoiceStripePayments.revocationState,
  }).from(invoiceStripePayments)
    .where(and(
      eq(invoiceStripePayments.stripeObjectId, session.id),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
    )).limit(1);
  if (mapping && mapping.revocationState !== 'active' && mapping.revocationState !== 'legacy_unbounded') {
    await markSessionChargedRepair(
      session.id,
      `session settled while revocation_state=${mapping.revocationState}`,
    );
  }

  return { settled: true, invoiceId: res.invoiceId };
}
