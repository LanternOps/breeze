import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoiceCollectionAttempts, invoices, orgPaymentMethods } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { getPartnerStripeClient } from '../partnerStripe';

/** Resolve historical account authority without consulting the mutable enrollment. */
export async function resolveAttemptProvenance(attempt: typeof invoiceCollectionAttempts.$inferSelect,
  invoice: typeof invoices.$inferSelect) {
  const { method, candidates, bankSetupId } = await withSystemDbAccessContext(async () => {
    const [method] = attempt.paymentMethodId ? await db.select().from(orgPaymentMethods)
      .where(and(eq(orgPaymentMethods.id, attempt.paymentMethodId), eq(orgPaymentMethods.orgId, attempt.orgId))).limit(1) : [];
    if (!method) throw new Error('Attempt payment-method provenance missing');
    const bankSetupId = /^autopay-bankpay:([0-9a-f-]{36})$/i.exec(attempt.idempotencyKey)?.[1];
    const candidates = await db.select().from(autopaySetupAttempts).where(and(
      eq(autopaySetupAttempts.orgId, attempt.orgId), eq(autopaySetupAttempts.partnerId, invoice.partnerId),
      eq(autopaySetupAttempts.enrollmentId, method.enrollmentId),
      bankSetupId ? eq(autopaySetupAttempts.id, bankSetupId)
        : method.stripeSetupIntentId ? eq(autopaySetupAttempts.setupIntentId, method.stripeSetupIntentId)
          : eq(autopaySetupAttempts.source, 'pay_and_save'),
    ));
    return { method, candidates, bankSetupId };
  }, 'autopay.attemptProvenance');
  const matching: typeof candidates = [];
  for (const setup of candidates) {
    if (bankSetupId || method.stripeSetupIntentId) { matching.push(setup); continue; }
    // Pay-and-save has no SetupIntent: verify the capturing PI/session binds
    // this exact method on the setup's original account. Never guess by generation.
    if (!setup.paymentIntentId && !setup.checkoutSessionId) continue;
    const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(invoice.partnerId, {
      reconciliationAccountId: setup.stripeAccountId, reason: 'autopay_recovery',
    }));
    let intentId = setup.paymentIntentId;
    if (!intentId && setup.checkoutSessionId) {
      const session = await runOutsideDbContext(() => stripe.checkout.sessions.retrieve(setup.checkoutSessionId!));
      intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    }
    if (!intentId) continue;
    const pi = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(intentId!));
    const pm = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
    if (pm === method.stripePaymentMethodId && pi.metadata.autopay_setup_attempt_id === setup.id
      && pi.status === 'succeeded') matching.push(setup);
  }
  const accounts = new Set(matching.map(row => row.stripeAccountId));
  if (accounts.size !== 1) throw new Error('Attempt Stripe account provenance missing or ambiguous');
  if (!matching[0]!.stripeCustomerId) throw new Error('Attempt customer provenance missing');
  return { stripeAccountId: matching[0]!.stripeAccountId, stripeCustomerId:matching[0]!.stripeCustomerId,
    stripeConnectionId: matching[0]!.stripeConnectionId, methodType: method.type };
}
