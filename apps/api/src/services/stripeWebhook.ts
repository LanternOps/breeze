// apps/api/src/services/stripeWebhook.ts
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getStripe } from './stripeClient';
import { getConfig } from '../config/validate';
import { db, withSystemDbAccessContext } from '../db';
import { invoices } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recordStripePayment, reflectStripeRefund } from './stripeReconcile';
import { markDisconnectedByAccount } from './stripeConnectService';
import { emitInvoiceEvent } from './invoiceEvents';

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
  switch (event.type) {
    case 'checkout.session.completed':
    case 'payment_intent.succeeded': {
      const obj = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
      const isSession = event.type === 'checkout.session.completed';
      const stripeObjectId = obj.id;
      const paymentIntentId = isSession
        ? String((obj as Stripe.Checkout.Session).payment_intent ?? '')
        : (obj as Stripe.PaymentIntent).id;
      const amountCents = isSession
        ? Number((obj as Stripe.Checkout.Session).amount_total ?? 0)
        : Number((obj as Stripe.PaymentIntent).amount_received ?? 0);
      const currency = String((obj as { currency?: string }).currency ?? 'usd').toUpperCase();
      if (!paymentIntentId || amountCents <= 0) return;
      await recordStripePayment({
        stripeObjectId, stripePaymentIntentId: paymentIntentId, stripeAccountId: event.account ?? '',
        amount: (amountCents / 100).toFixed(2), currency
      });
      return;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await withSystemDbAccessContext(async () => {
        const [m] = await db.select().from(invoiceStripePayments)
          .where(eq(invoiceStripePayments.stripePaymentIntentId, pi.id)).limit(1);
        if (!m) return;
        await db.update(invoiceStripePayments)
          .set({ status: 'failed', lastEventAt: new Date(), updatedAt: new Date() })
          .where(eq(invoiceStripePayments.id, m.id));
        const [inv] = await db.select({ partnerId: invoices.partnerId }).from(invoices)
          .where(eq(invoices.id, m.invoiceId)).limit(1);
        await emitInvoiceEvent({
          type: 'payment.failed', invoiceId: m.invoiceId, orgId: m.orgId,
          partnerId: inv?.partnerId ?? '', paymentId: m.invoicePaymentId ?? ''
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
        chargeAmountCents: Number(ch.amount ?? 0)
      });
      return;
    }
    case 'account.application.deauthorized': {
      if (event.account) await markDisconnectedByAccount(event.account);
      return;
    }
    default:
      return; // ignore everything else
  }
}
