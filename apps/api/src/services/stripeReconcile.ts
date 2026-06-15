import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { invoices, invoicePayments } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recomputeInvoiceStatus } from './invoiceService';
import { emitInvoiceEvent } from './invoiceEvents';

function toCents(v: string | number) { return Math.round(Number(v) * 100); }

interface CaptureInput {
  stripeObjectId: string;            // cs_… or pi_…
  stripePaymentIntentId: string;     // pi_…
  stripeAccountId: string;
  amount: string;                    // major units, e.g. "100.00"
  currency: string;
  receivedAt?: string;               // YYYY-MM-DD
}

/**
 * Reconcile a captured Stripe charge into the engine. System DB context (webhook is unauth).
 * Idempotent via the invoice_stripe_payments mapping (unique stripe_object_id) and the
 * mapping.invoice_payment_id guard. Single reconcile point: recomputeInvoiceStatus.
 */
export async function recordStripePayment(input: CaptureInput): Promise<{ invoiceId: string }> {
  return withSystemDbAccessContext(async () => {
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripeObjectId, input.stripeObjectId)).limit(1);
    if (!mapping) throw new Error(`No mapping for stripe object ${input.stripeObjectId}`);
    if (mapping.invoicePaymentId) return { invoiceId: mapping.invoiceId }; // already recorded — no-op

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, mapping.invoiceId)).limit(1);
    if (!inv) throw new Error(`Invoice ${mapping.invoiceId} not found`);
    if (inv.status === 'draft' || inv.status === 'void') {
      await markMapping(mapping.id, 'failed');
      throw new Error(`Cannot record payment on ${inv.status} invoice`);
    }
    if (toCents(input.amount) > toCents(inv.balance)) {
      await markMapping(mapping.id, 'failed');
      throw new Error('OVERPAYMENT: payment exceeds balance');
    }

    const [payment] = await db.insert(invoicePayments).values({
      invoiceId: inv.id, orgId: inv.orgId, amount: Number(input.amount).toFixed(2),
      method: 'card', reference: input.stripePaymentIntentId,
      receivedAt: input.receivedAt ?? new Date().toISOString().slice(0, 10), recordedBy: null, note: null
    }).returning();

    await db.update(invoiceStripePayments)
      .set({ invoicePaymentId: payment!.id, status: 'succeeded', stripePaymentIntentId: input.stripePaymentIntentId,
             lastEventAt: new Date(), updatedAt: new Date() })
      .where(eq(invoiceStripePayments.id, mapping.id));

    await recomputeInvoiceStatus(inv.id);
    await emitInvoiceEvent({ type: 'payment.recorded', invoiceId: inv.id, orgId: inv.orgId,
      partnerId: inv.partnerId, paymentId: payment!.id });

    const [updated] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    if (updated?.status === 'paid') {
      await emitInvoiceEvent({ type: 'invoice.paid', invoiceId: inv.id, orgId: inv.orgId, partnerId: inv.partnerId });
    }
    return { invoiceId: inv.id };
  });
}

export async function markMapping(mappingId: string, status: 'failed' | 'refunded' | 'partially_refunded'): Promise<void> {
  await db.update(invoiceStripePayments)
    .set({ status, lastEventAt: new Date(), updatedAt: new Date() })
    .where(eq(invoiceStripePayments.id, mappingId));
}

interface RefundInput {
  stripePaymentIntentId: string;
  amountRefundedCents: number; // cumulative refunded on the charge
  chargeAmountCents: number;   // original captured amount
}

/** Reflect a Stripe-side refund. No Breeze-initiated money movement. System context. */
export async function reflectStripeRefund(input: RefundInput): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, input.stripePaymentIntentId)).limit(1);
    if (!mapping || !mapping.invoicePaymentId) return; // nothing to reflect

    const paymentId = mapping.invoicePaymentId;
    const full = input.amountRefundedCents >= input.chargeAmountCents;
    if (full) {
      // Full refund → void the payment row (mirrors voidPayment mechanics).
      await db.delete(invoicePayments).where(eq(invoicePayments.id, paymentId));
      await db.update(invoiceStripePayments)
        .set({ status: 'refunded', invoicePaymentId: null, lastEventAt: new Date(), updatedAt: new Date() })
        .where(eq(invoiceStripePayments.id, mapping.id));
    } else {
      // Partial refund → reduce the positive payment amount (stays > 0; respects the amount>0 CHECK).
      const remainingCents = input.chargeAmountCents - input.amountRefundedCents;
      await db.update(invoicePayments)
        .set({ amount: (remainingCents / 100).toFixed(2) })
        .where(eq(invoicePayments.id, paymentId));
      await db.update(invoiceStripePayments)
        .set({ status: 'partially_refunded', lastEventAt: new Date(), updatedAt: new Date() })
        .where(eq(invoiceStripePayments.id, mapping.id));
    }
    await recomputeInvoiceStatus(mapping.invoiceId);
    await emitInvoiceEvent({ type: 'payment.voided', invoiceId: mapping.invoiceId, orgId: mapping.orgId,
      partnerId: await invoicePartnerId(mapping.invoiceId), paymentId });
  });
}

async function invoicePartnerId(invoiceId: string): Promise<string> {
  const [inv] = await db.select({ partnerId: invoices.partnerId }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return inv!.partnerId;
}
