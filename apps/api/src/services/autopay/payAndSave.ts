import {enqueueRejectedAutopayMethod} from './paymentMethods';
import type {InvoiceAutopayOffer} from '@breeze/shared';
import {autopayConsentSnapshotSchema} from './types';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { organizations, orgAutopayEnrollments, invoiceStripePayments, invoices } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { getPartnerStripeClient } from '../partnerStripe';
import { InvoiceServiceError } from '../invoiceTypes';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { prepareAutopayCapture } from './setupSession';
import { persistCapturedAutopayMethod } from './setupCompletion';
import { withAcceptedAutopayDisclosure, buildAutopayDisclosure } from './consentText';
import { isAutopayEnabledForPartner } from './autopayGate';
import { AUTOPAY_CHECKOUT_WALLET_OPTIONS } from './feeDisclosure';

export const payAndSaveSchema = z.object({
  saveForAutopay: z.boolean().default(false),
  consentAccepted: z.literal(true).optional(),
  disclosureHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).superRefine((value, ctx) => {
  if (value.saveForAutopay && (value.consentAccepted !== true || !value.disclosureHash)) {
    ctx.addIssue({ code: 'custom', message: 'Explicit authorization is required', path: ['consentAccepted'] });
  }
});

export type CardSaveInput = {
  saveForAutopay?: boolean;
  consentAccepted?: true;
  disclosureHash?: string;
  ip?: string | null;
  userAgent?: string | null;
  contactEmail?: string;
};

export function cardSaveStripeFields(
  attempt: { id: string; stripeCustomerId: string | null } | null,
): Pick<Stripe.Checkout.SessionCreateParams, 'customer' | 'payment_intent_data' | 'wallet_options'> {
  if (!attempt) return {};
  if (!attempt.stripeCustomerId) throw new Error('Autopay Customer missing');
  return {
    customer: attempt.stripeCustomerId,
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata: { autopay_setup_attempt_id: attempt.id },
    },
    wallet_options: AUTOPAY_CHECKOUT_WALLET_OPTIONS,
  };
}

export async function prepareCardPayAndSave(invoiceId: string, orgId: string, input: CardSaveInput, checkoutKey: string) {
  if (!input.saveForAutopay) return null;
  if (input.consentAccepted !== true || !input.disclosureHash) {
    throw new InvoiceServiceError('Authorize automatic payments first', 400, 'INVALID_STATE');
  }
  const [org] = await withSystemDbAccessContext(() =>
    db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1));
  const email = input.contactEmail ?? (org?.billingContact as { email?: string } | null)?.email;
  if (!email) throw new InvoiceServiceError('A billing contact is required', 409, 'INVALID_STATE');
  return withAcceptedAutopayDisclosure(input.disclosureHash, () => prepareAutopayCapture({
    orgId, methodType: 'card', consentAccepted: true, returnTo: 'portal',
    contactEmail: email, ip: input.ip ?? null, userAgent: input.userAgent ?? null,
  }, 'pay_and_save', invoiceId, checkoutKey));
}

export async function getInvoiceAutopayOffer(orgId: string): Promise<InvoiceAutopayOffer | null> {
  // orgId comes only from an authorized invoice or the verified portal identity.
  // The complete disclosure also reads partner-axis settings invisible to portal RLS.
  return readWithPartnerAxisVisibility(async () => {
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.orgId, orgId)).limit(1);
    if (!enrollment || !['requested', 'active'].includes(enrollment.status)
      || !await isAutopayEnabledForPartner(db, enrollment.partnerId)) return null;
    const disclosure = await buildAutopayDisclosure(db, orgId, 'card');
    if (disclosure.achMode === 'ach_only') return null;
    return { eligible: true, consentText: disclosure.text, consentVersion: disclosure.version, disclosureHash: disclosure.hash };
  });
}

export async function finishCardPayAndSave(partnerId: string, checkoutSessionId: string): Promise<{outcome: 'not_saved'} | Awaited<ReturnType<typeof persistCapturedAutopayMethod>>> {
  assertNoHeldDbContextForStripe('finishCardPayAndSave');
  // Stripe being paid is insufficient: terminal/refused captures also return an
  // invoice id. Only a durable invoice payment authorizes saving the card.
  const [mapping] = await withSystemDbAccessContext(() => db.select({ mapping: invoiceStripePayments, invoice: invoices })
    .from(invoiceStripePayments).innerJoin(invoices, eq(invoices.id, invoiceStripePayments.invoiceId))
    .where(and(
      eq(invoiceStripePayments.stripeObjectId, checkoutSessionId),
      eq(invoices.partnerId, partnerId),
    )).limit(1));
  const findBoundCapture=()=>withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(
    eq(autopaySetupAttempts.checkoutSessionId,checkoutSessionId),eq(autopaySetupAttempts.partnerId,partnerId),eq(autopaySetupAttempts.source,'pay_and_save'))).limit(1));
  const [bound]=!mapping?.mapping.invoicePaymentId?await findBoundCapture():[];
  if(!mapping?.mapping.invoicePaymentId&&!bound)return {outcome:'not_saved'};
  const { stripe, stripeAccountId } = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId));
  if (stripeAccountId !== (mapping?.mapping.stripeAccountId??bound?.stripeAccountId)) throw new Error('Stripe account changed');
  const session = await runOutsideDbContext(() => stripe.checkout.sessions.retrieve(checkoutSessionId));
  if (session.mode !== 'payment' || session.payment_status !== 'paid') return {outcome:'not_saved'};
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!piId) return {outcome:'not_saved'};
  const intent = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(piId));
  const attemptId = intent.metadata.autopay_setup_attempt_id;
  if (!attemptId) return {outcome:'not_saved'};
  const [scopedAttempt] = bound?[bound]:await withSystemDbAccessContext(() => db.select().from(autopaySetupAttempts).where(and(
    eq(autopaySetupAttempts.id, attemptId),
    eq(autopaySetupAttempts.partnerId, partnerId),
    eq(autopaySetupAttempts.orgId, mapping!.invoice.orgId),
    eq(autopaySetupAttempts.stripeAccountId, stripeAccountId),
    eq(autopaySetupAttempts.source, 'pay_and_save'),
  )).limit(1));
  const attempt=scopedAttempt??(await findBoundCapture())[0];
  if(!attempt||attempt.stripeAccountId!==stripeAccountId||attempt.id!==attemptId||intent.status!=='succeeded')return {outcome:'not_saved'};
  const customer = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;

  const methodId = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
  if (!methodId) throw new Error('Paid card has no payment method');
  const method = await runOutsideDbContext(() => stripe.paymentMethods.retrieve(methodId));
  if(customer!==attempt.stripeCustomerId||method.type!=='card'){
    await withSystemDbAccessContext(()=>enqueueRejectedAutopayMethod(db,attempt,method));
    throw new Error(customer!==attempt.stripeCustomerId?'Pay-and-save Customer mismatch':'Pay-and-save must remain card-only');
  }
  if(!mapping?.mapping.invoicePaymentId||mapping.invoice.orgId!==attempt.orgId||autopayConsentSnapshotSchema.parse(attempt.consentSnapshot).invoiceId!==mapping.invoice.id||intent.setup_future_usage!=='off_session'){
    await withSystemDbAccessContext(()=>enqueueRejectedAutopayMethod(db,attempt,method));
    return {outcome:'not_saved'};
  }
  return persistCapturedAutopayMethod(attempt.id, method, 'activated', null, null);
}

/** Bind only after the invoice mapping commits; pending attempts remain recoverable. */
export async function bindCardPayAndSave(
  attempt: { id: string } | null,
  session: Pick<Stripe.Checkout.Session, 'id' | 'payment_intent'>,
): Promise<void> {
  if (!attempt) return;
  await withSystemDbAccessContext(() => db.update(autopaySetupAttempts).set({
    checkoutSessionId: session.id,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
  }).where(eq(autopaySetupAttempts.id, attempt.id)));
}
