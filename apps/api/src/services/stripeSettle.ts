import { hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { getPartnerStripeClient } from './partnerStripe';
import { recordStripePayment } from './stripeReconcile';
import { fromMinorUnits } from './stripeMoney';

/**
 * Throws when a DB access context is held. Both the settle primitive and the
 * reconcile sweep make Stripe network calls, and a context here is a
 * transaction: every Stripe round-trip would pin its pooled connection (and,
 * after `recordStripePayment`, the invoice row lock) idle-in-transaction, and
 * `recordStripePayment`'s own transaction would become a nested no-op, so its
 * post-commit events and push jobs would fire before anything committed (#7065).
 *
 * Deliberately a throw, not `runOutsideDbContext`: escaping would open a SECOND
 * pooled connection while the caller's transaction is still held, which
 * deadlocks the pool at concurrency >= pool size (#6671). A request route that
 * needs this must own its context (SELF_MANAGED_DB_CONTEXT_ROUTES).
 */
export class HeldDbContextForStripeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeldDbContextForStripeError';
  }
}

/**
 * Callers' best-effort catch blocks (settle routes, the sweep's per-row loop)
 * MUST rethrow this error rather than degrade it to "not settled yet": it is a
 * programming error that would otherwise silently turn off instant settlement.
 */
export function assertNoHeldDbContextForStripe(operation: string): void {
  if (hasDbAccessContext()) {
    throw new HeldDbContextForStripeError(
      `${operation} must run outside any DB access context: it makes Stripe network calls and opens its own `
      + 'short transactions (#7065). Close the caller\'s context first — do not escape it with runOutsideDbContext.',
    );
  }
}

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
 * Transaction scope (#7065): this function OWNS its DB contexts and must be
 * called with none held (asserted). No transaction ever spans the Stripe call:
 *   1. the partner key read runs in its own short system context;
 *   2. the Stripe retrieve runs outside any context;
 *   3. `recordStripePayment` opens and COMMITS its own transaction, so its
 *      post-commit events / accounting push really do run after the commit;
 *   4. the SEC-150 charged-repair park rides inside that same transaction.
 * System scope is needed throughout: the key row is partner-axis, which an
 * org-scoped portal context cannot see (the #1375 class).
 */
export async function settleCheckoutSession(
  partnerId: string,
  sessionId: string,
): Promise<{ settled: boolean; invoiceId?: string }> {
  assertNoHeldDbContextForStripe('settleCheckoutSession');
  const { stripe, stripeAccountId } = await withSystemDbAccessContext(
    () => getPartnerStripeClient(partnerId), 'stripeSettle.partnerKey');
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
  }, {
    // SEC-150 charged-repair, stamped INSIDE the capture's transaction so the
    // park commits atomically with whatever the capture decided — see
    // recordStripePayment. A separate transaction afterwards could lose the
    // park after the capture (or its terminal-fail) had already committed.
    markChargedRepairIfRevoked: true,
  });

  return { settled: true, invoiceId: res.invoiceId };
}
