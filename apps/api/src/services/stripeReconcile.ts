import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { invoices, invoicePayments } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recomputeInvoiceStatus } from './invoiceService';
import { emitInvoiceEvent } from './invoiceEvents';
import { fromMinorUnits } from './stripeMoney';
import { captureException } from './sentry';

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
    // A genuinely missing mapping is unexpected/transient (race against the pay
    // route's INSERT, or a stale redelivery) — throw so the webhook 500s and
    // Stripe retries, by which point the mapping should exist.
    if (!mapping) throw new Error(`No mapping for stripe object ${input.stripeObjectId}`);
    if (mapping.invoicePaymentId) return { invoiceId: mapping.invoiceId }; // already recorded — no-op

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, mapping.invoiceId)).limit(1);
    if (!inv) throw new Error(`Invoice ${mapping.invoiceId} not found`);

    // TERMINAL conditions: a retry will NEVER succeed, so we must not throw (a
    // thrown error → 500 → Stripe retries forever). Instead mark the mapping
    // failed, surface a payment.failed event, and RETURN 202-cleanly.
    const terminalFail = async (reason: string): Promise<{ invoiceId: string }> => {
      console.warn('[stripeReconcile] terminal payment failure', { stripeObjectId: input.stripeObjectId, invoiceId: inv.id, reason });
      // A customer was charged on Stripe and we are refusing to record it (currency
      // mismatch, overpayment, account mismatch, void/draft invoice). That is a money
      // divergence requiring human reconciliation — surface it to Sentry, not just logs.
      captureException(new Error(`[stripeReconcile] terminal payment failure (${reason}) stripeObjectId=${input.stripeObjectId} invoiceId=${inv.id}`));
      await markMapping(mapping.id, 'failed');
      await emitInvoiceEvent({ type: 'payment.failed', invoiceId: inv.id, orgId: inv.orgId, partnerId: inv.partnerId });
      return { invoiceId: inv.id };
    };

    if (inv.status === 'draft' || inv.status === 'void') {
      return terminalFail(`invoice is ${inv.status}`);
    }
    // Defense-in-depth (F4): the verified webhook amount must be in the invoice's
    // own currency, and the charge must have landed on the account the mapping
    // was created against. A mismatch means tampering or a routing bug, never a
    // transient — terminal-fail rather than silently writing a wrong-currency row.
    if (String(input.currency).toUpperCase() !== String(inv.currencyCode).toUpperCase()) {
      return terminalFail(`currency mismatch (event=${input.currency} invoice=${inv.currencyCode})`);
    }
    if (!input.stripeAccountId || input.stripeAccountId !== mapping.stripeAccountId) {
      return terminalFail(`account mismatch (event=${input.stripeAccountId} mapping=${mapping.stripeAccountId})`);
    }
    if (toCents(input.amount) > toCents(inv.balance)) {
      return terminalFail('overpayment: payment exceeds balance');
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
  currency: string;           // charge currency (drives minor-unit conversion)
  stripeAccountId: string;    // event.account — must match the mapping's connected account
}

/** Reflect a Stripe-side refund. No Breeze-initiated money movement. System context. */
export async function reflectStripeRefund(input: RefundInput): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, input.stripePaymentIntentId)).limit(1);
    if (!mapping) {
      // No mapping for this PI — leave a forensic trail (money divergence: a refund
      // landed for a charge we have no record of, or a redelivery after cleanup).
      console.warn('[stripeReconcile] refund for unknown payment_intent — no mapping', { stripePaymentIntentId: input.stripePaymentIntentId });
      return;
    }
    if (!mapping.invoicePaymentId) {
      // Mapping exists but was never linked to a payment row (e.g. the charge was
      // terminal-failed). Nothing to reflect, but record why for reconciliation.
      console.warn('[stripeReconcile] refund for a payment_intent with no linked payment row', { stripePaymentIntentId: input.stripePaymentIntentId, mappingId: mapping.id });
      return;
    }

    // Account binding (mirror recordStripePayment's guard): a refund event whose
    // account does not match the mapping's connected account must never mutate
    // another account's payment row.
    if (!input.stripeAccountId || input.stripeAccountId !== mapping.stripeAccountId) {
      console.warn('[stripeReconcile] refund account mismatch — refusing to mutate payment row', {
        stripePaymentIntentId: input.stripePaymentIntentId, eventAccount: input.stripeAccountId, mappingAccount: mapping.stripeAccountId,
      });
      return;
    }

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
      // Currency-aware: zero-decimal currencies (JPY, …) must NOT be divided by 100.
      const remainingCents = input.chargeAmountCents - input.amountRefundedCents;
      await db.update(invoicePayments)
        .set({ amount: fromMinorUnits(remainingCents, input.currency) })
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
