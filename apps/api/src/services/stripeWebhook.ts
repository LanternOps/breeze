// apps/api/src/services/stripeWebhook.ts
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getStripe } from './stripeClient';
import { getConfig } from '../config/validate';
import { db, withSystemDbAccessContext } from '../db';
import { invoices } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recordStripePayment, reflectStripeRefund } from './stripeReconcile';
import { markDisconnectedByAccount, getConnectionByAccount } from './stripeConnectService';
import { emitInvoiceEvent } from './invoiceEvents';
import { fromMinorUnits } from './stripeMoney';

export function verifyStripeEvent(rawBody: string, signatureHeader: string): Stripe.Event {
  const secret = getConfig().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  // constructEvent enforces the t=/v1= scheme + 5-min replay tolerance.
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, secret);
}

/**
 * Dispatch a verified Stripe Connect event. Webhook is unauthenticated, so all DB
 * work runs in system context. Idempotency lives in the reconcile layer (unique
 * stripe_object_id mapping + invoice_payment_id guard); this dispatcher only routes.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  // livemode guard (spec §11) + account binding. For money-moving events, resolve
  // the connection via event.account and refuse to process unless it exists AND
  // its stored livemode matches event.livemode — a test-mode event must never
  // touch a live connection (or vice-versa). account.application.deauthorized is
  // exempt: a revoked account legitimately may no longer match.
  const MONEY_MOVING = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'charge.refunded',
    'payment_intent.payment_failed',
  ]);
  if (MONEY_MOVING.has(event.type)) {
    const connection = event.account ? await getConnectionByAccount(event.account) : null;
    if (!connection || connection.livemode !== Boolean(event.livemode)) {
      console.warn('[stripeWebhook] ignoring event — unknown account or livemode mismatch', {
        type: event.type, account: event.account, eventLivemode: event.livemode,
        connectionLivemode: connection?.livemode ?? null,
      });
      return; // 202, no processing
    }
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // ONLY the Checkout session records a capture: it is keyed on the session id
      // (the mapping's stripe_object_id) and carries payment_intent + amount_total.
      // payment_intent.succeeded is intentionally NOT handled — handling both would
      // double-fire on every payment and trigger a redelivery/retry storm.
      const session = event.data.object as Stripe.Checkout.Session;
      // Funds-settled gate: a completed session is NOT necessarily paid. Async
      // methods (e.g. bank debits) fire checkout.session.completed with
      // payment_status='unpaid' and only later settle via
      // checkout.session.async_payment_succeeded (which carries
      // payment_status='paid'). Recording before funds settle would mark the
      // invoice paid on money we don't have. v1 is card-only so this is
      // belt-and-suspenders, but it must hold if an MSP later enables async
      // methods. Only record once payment_status is 'paid'.
      if (session.payment_status !== 'paid') return;
      const stripeObjectId = session.id;
      const paymentIntentId = String(session.payment_intent ?? '');
      const amountCents = Number(session.amount_total ?? 0);
      const currency = String(session.currency ?? 'usd').toUpperCase();
      if (!paymentIntentId || amountCents <= 0) return;
      await recordStripePayment({
        stripeObjectId, stripePaymentIntentId: paymentIntentId, stripeAccountId: event.account ?? '',
        amount: fromMinorUnits(amountCents, currency), currency
      });
      return;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await withSystemDbAccessContext(async () => {
        const [m] = await db.select().from(invoiceStripePayments)
          .where(eq(invoiceStripePayments.stripePaymentIntentId, pi.id)).limit(1);
        if (!m) {
          // No mapping for this PI — a payment_failed for a charge we never tracked
          // (or a redelivery after cleanup). Leave a forensic trail before returning.
          console.warn('[stripeWebhook] payment_intent.payment_failed for unknown payment_intent', { paymentIntentId: pi.id, account: event.account });
          return;
        }
        await db.update(invoiceStripePayments)
          .set({ status: 'failed', lastEventAt: new Date(), updatedAt: new Date() })
          .where(eq(invoiceStripePayments.id, m.id));
        // Look up the invoice's partnerId so the surfaced event carries the real
        // partner (not an empty string).
        const [inv] = await db.select({ partnerId: invoices.partnerId }).from(invoices)
          .where(eq(invoices.id, m.invoiceId)).limit(1);
        await emitInvoiceEvent({
          type: 'payment.failed', invoiceId: m.invoiceId, orgId: m.orgId,
          partnerId: inv?.partnerId ?? '', paymentId: m.invoicePaymentId ?? undefined
        });
      });
      return;
    }
    case 'charge.refunded': {
      const ch = event.data.object as Stripe.Charge;
      if (!ch.payment_intent) return;
      await reflectStripeRefund({
        stripePaymentIntentId: String(ch.payment_intent),
        amountRefundedCents: Number(ch.amount_refunded ?? 0),
        chargeAmountCents: Number(ch.amount ?? 0),
        currency: String(ch.currency ?? 'usd'),
        stripeAccountId: event.account ?? '' // account-binding guard in reflectStripeRefund
      });
      return;
    }
    case 'account.application.deauthorized': {
      if (event.account) await markDisconnectedByAccount(event.account);
      return;
    }
    default:
      return; // ignore everything else (incl. payment_intent.succeeded)
  }
}
