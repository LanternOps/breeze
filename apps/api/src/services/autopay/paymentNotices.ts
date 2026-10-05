import { reportCollectionError } from './collectionErrors';
import { and, eq } from 'drizzle-orm';
import { formatPaymentMethod, paymentMethodInSentence } from '@breeze/shared';
import { invoiceCollectionAttempts, invoiceStripePayments, invoices, organizations, partners, orgPaymentMethods, orgAutopayEnrollments, billingNoticeOutbox, invoiceAutopaySchedules } from '../../db/schema';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { resolveBillingEmail } from '../invoicePdf';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import { mintBillingLinkToken, buildBillingLinkUrl } from './linkTokens';
import { enqueueBillingNotice } from './noticeOutbox';
import { renderBillingNotice, renderRefundNotice, type PaymentSecondaryAction } from './renderBillingNotice';
import type { Tx } from './types';
import { sendAutopayStaffEmail } from './staffNotifications';
export function noticeDedupeKey(id: string, kind: string): string { return `${id}:${kind}:1`; }
export function returnedNoticeDedupeKey(attemptId: string,returnIdentity: string): string {
  if (!returnIdentity) throw new Error('Returned payment requires an applied return identity');
  return `${attemptId}:payment_failed:returned:${returnIdentity}`;
}
export async function enqueueOnlineReceipt(tx: Tx, mappingId: string): Promise<void> {
  const [mapping] = await tx.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.id, mappingId)).limit(1);
  if (!mapping?.invoicePaymentId || mapping.status !== 'succeeded') return;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, mapping.invoiceId)).limit(1);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, mapping.orgId)).limit(1);
  if (!invoice) throw new Error('Invoice not found for notice');
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  if (!invoice || !org || !partner || org.id !== invoice.orgId || org.partnerId !== invoice.partnerId) throw new Error('Payment notice ownership mismatch');
  const email = resolveBillingEmail(org.billingContact);
  if (!email) return;
  const total = fromMinorUnits(toMinorUnits(mapping.amount, mapping.currency)
    + toMinorUnits(mapping.feeAmount, mapping.currency), mapping.currency);
  const methodLabel = await receiptMethodLabel(tx, mapping);
  const vars = { org_name: org!.name, partner_name: partner!.name, invoice_number: invoice!.invoiceNumber!,
    amount_paid: `${mapping.currency} ${mapping.amount}`, fee_amount: `${mapping.currency} ${mapping.feeAmount}`,
    total_charged: `${mapping.currency} ${total}`, payment_method: methodLabel,
    paid_on: mapping.paymentReceivedAt!, balance_remaining: `${invoice!.currencyCode} ${invoice!.balance}` };
  const rendered = await renderBillingNotice('payment_receipt', { payment: { id: 'payment_receipt', vars,
    custom: partnerEmailCustomFromSettings(partner!.settings, 'payment_receipt'),
    frozen: { mappingId: mapping.id, amount: mapping.amount, fee: mapping.feeAmount, total,
      invoiceNumber: invoice!.invoiceNumber ?? null, partnerName: partner!.name, methodLabel } } });
  await enqueueBillingNotice(tx, { orgId: mapping.orgId, partnerId: invoice!.partnerId, invoiceId: invoice!.id,
    kind: 'payment_receipt', seq: 1, dedupeKey: noticeDedupeKey(mapping.id, 'payment_receipt'), toEmail: email, rendered });
}
/** D-20: Stripe reported a new refund (cumulative refundedMinor, gross of any fee) on a
 * payment the client was charged. Tells them the amount, where it goes and the invoice
 * balance afterwards. Caller holds the invoice lock and has recomputed the balance. */
export async function enqueueRefundNotice(tx: Tx, mappingId: string,
  refund: { priorRefundedMinor: number; refundedMinor: number }): Promise<void> {
  if (refund.refundedMinor <= refund.priorRefundedMinor) return;
  const [mapping] = await tx.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.id, mappingId)).limit(1);
  if (!mapping?.paymentReceivedAt) return;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, mapping.invoiceId)).limit(1);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, mapping.orgId)).limit(1);
  if (!invoice) throw new Error('Invoice not found for notice');
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  if (!org || !partner || org.id !== invoice.orgId || org.partnerId !== invoice.partnerId || mapping.orgId !== invoice.orgId) {
    throw new Error('Payment notice ownership mismatch');
  }
  const email = resolveBillingEmail(org.billingContact);
  if (!email) return;
  const money = (amount: string) => `${mapping.currency} ${amount}`;
  const refunded = fromMinorUnits(refund.refundedMinor - refund.priorRefundedMinor, mapping.currency);
  const original = fromMinorUnits(toMinorUnits(mapping.amount, mapping.currency) + toMinorUnits(mapping.feeAmount, mapping.currency), mapping.currency);
  const methodLabel = await receiptMethodLabel(tx, mapping);
  const known = methodLabel !== 'Online payment';
  const rendered = renderRefundNotice({ partnerName: partner.name, invoiceNumber: invoice.invoiceNumber ?? '',
    refunded: money(refunded), refundedTo: known ? methodLabel : 'the original payment method',
    originalPayment: `${money(original)} on ${mapping.paymentReceivedAt}`,
    full: refund.refundedMinor >= toMinorUnits(original, mapping.currency),
    balanceLine: toMinorUnits(invoice.balance, invoice.currencyCode) > 0
      ? `Balance due on invoice ${invoice.invoiceNumber} after this refund: ${invoice.currencyCode} ${invoice.balance}`
      : `Invoice ${invoice.invoiceNumber} has no balance due.`,
    invoiceUrl: buildPublicInvoiceUrl((await getOrMintInvoiceLink(invoice, tx)).token),
    frozen: { mappingId: mapping.id, variant: 'refund', refundedAmount: refunded,
      refundedTotal: fromMinorUnits(refund.refundedMinor, mapping.currency), currency: mapping.currency,
      balanceAfter: invoice.balance, invoiceNumber: invoice.invoiceNumber ?? null, partnerName: partner.name,
      methodLabel: known ? methodLabel : null } });
  await enqueueBillingNotice(tx, { orgId: mapping.orgId, partnerId: invoice.partnerId, invoiceId: invoice.id,
    kind: 'payment_receipt', seq: 1, dedupeKey: `${mapping.id}:payment_receipt:refund:${refund.refundedMinor}`, toEmail: email, rendered });
}
/** "Paid with" on a receipt. Never "Card" for a payment Breeze cannot see: a pay-link
 * Checkout may complete by card, Link, a bank account or Klarna, and its mapping
 * records no method type, so it reads "Online payment". */
async function receiptMethodLabel(tx: Tx, mapping: typeof invoiceStripePayments.$inferSelect): Promise<string> {
  if (mapping.paymentMethodType !== 'card' && mapping.paymentMethodType !== 'us_bank_account') return 'Online payment';
  const [attempt] = mapping.source === 'autopay' ? await tx.select({ paymentMethodId: invoiceCollectionAttempts.paymentMethodId })
    .from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceStripePaymentId, mapping.id)).limit(1) : [];
  const [method] = attempt?.paymentMethodId ? await tx.select().from(orgPaymentMethods).where(and(
    eq(orgPaymentMethods.id, attempt.paymentMethodId), eq(orgPaymentMethods.orgId, mapping.orgId))).limit(1) : [];
  if (method && method.type === mapping.paymentMethodType) return formatPaymentMethod(method);
  return mapping.paymentMethodType === 'us_bank_account' ? 'Bank account' : 'Card';
}
const NO_AUTOMATIC_RETRY = 'There will be no automatic retry. You can pay this invoice now.';
/** Secondary action of every update-method email. True today: a failed schedule is never
 * re-planned, so a new method cannot collect this invoice. */
function updateMethodAction(url: string): PaymentSecondaryAction {
  return { url, label: 'Update payment method',
    note: 'Updating your payment method keeps automatic payments working for future invoices. It does not pay this invoice.' };
}
/** fallback: re-issue a queued notice whose update-method link stopped being true before
 * dispatch (paymentNoticeValidation). It never carries an update link and has its own dedupe key. */
export async function enqueueAttemptNotice(tx: Tx, attemptId: string,
  variant: 'receipt' | 'confirm' | 'update' | 'pay' | 'returned' | 'expired', returnIdentity?: string,
  options: { fallback?: boolean } = {}): Promise<void> {
  let [attempt] = await tx.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.id, attemptId)).limit(1);
  if (variant === 'returned' && !returnIdentity) throw new Error('Returned payment identity missing');
  if (!attempt) throw new Error('Attempt not found for notice');
  if (variant === 'receipt') {
    if (attempt.invoiceStripePaymentId) await enqueueOnlineReceipt(tx, attempt.invoiceStripePaymentId);
    return;
  }
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, attempt.invoiceId)).limit(1).for('update');
  // Serialize notice replay with invoice writers, then re-read authority: a
  // merge may have cleared method ownership while the invoice lock was pending.
  [attempt] = await tx.select().from(invoiceCollectionAttempts)
    .where(eq(invoiceCollectionAttempts.id, attemptId)).limit(1).for('update');
  if (!attempt || attempt.invoiceId !== invoice?.id) throw new Error('Attempt changed before notice');
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, attempt.orgId)).limit(1);
  if (!invoice) throw new Error('Invoice not found for notice');
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  const [method] = attempt.paymentMethodId ? await tx.select().from(orgPaymentMethods)
    .where(eq(orgPaymentMethods.id,attempt.paymentMethodId)).limit(1) : [];
  if (!invoice || !org || !partner || org.id !== invoice.orgId || org.partnerId !== invoice.partnerId) throw new Error('Payment notice ownership mismatch');
  const email = resolveBillingEmail(org.billingContact);
  if (!email) return;
  if (variant === 'returned') {
    const [mapping] = attempt.invoiceStripePaymentId ? await tx.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.id, attempt.invoiceStripePaymentId)).limit(1) : [];
    if (!mapping || mapping.invoiceId !== invoice.id || mapping.orgId !== invoice.orgId
      || !mapping.paymentReceivedAt || !mapping.disputeFundsWithdrawn
      || !returnIdentity!.startsWith(`${mapping.id}:`) || returnIdentity === `${mapping.id}:`) {
      throw new Error('Returned payment requires an applied return identity');
    }
  }
  const dedupeKey = variant === 'returned' ? `${returnedNoticeDedupeKey(attemptId,returnIdentity!)}${options.fallback ? ':reissued' : ''}`
    : options.fallback && variant === 'pay' ? noticeDedupeKey(attemptId, 'payment_failed:pay:reissued')
    : noticeDedupeKey(attemptId, variant === 'expired' ? 'payment_expired' : 'payment_failed');
  const [existingNotice] = await tx.select({id:billingNoticeOutbox.id}).from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.dedupeKey,dedupeKey)).limit(1);
  if (existingNotice) return;
  const [enrollment] = method ? await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id,method.enrollmentId)).limit(1) : [];
  const hasAuthority = !!method && !!enrollment && method.orgId === invoice!.orgId
    && enrollment.orgId === invoice!.orgId && enrollment.status === 'active';
  // A merged history row may receive money notices but cannot mint collection controls.
  if ((variant === 'confirm' || variant === 'update') && !hasAuthority) return;
  // A hard or revoked bank return marked the autopay account unusable in this transaction
  // (2b-2): the returned email also says so and adds the update link, as the update variant does.
  const returnedUnusable = variant === 'returned' && !options.fallback && hasAuthority
    && method!.isAutopayMethod && method!.status === 'unusable';
  let tokenId: string | null = null;
  let methodLink: string | null = null;
  if (variant === 'confirm' || variant === 'update' || returnedUnusable) {
    const token = await mintBillingLinkToken(tx, { orgId: attempt.orgId, invoiceId: invoice!.id,
      enrollmentId: method!.enrollmentId, generation: enrollment!.generation, purpose: variant === 'confirm' ? 'confirm_payment' : 'enroll', ttlDays: 14 });
    tokenId = token.id;
    methodLink = buildBillingLinkUrl(variant === 'confirm' ? 'confirm_payment' : 'enroll', token.token);
  }
  // Confirm is the only way forward while that attempt holds the invoice (pay-now would 409).
  // Every other failure leads with paying this invoice; update adds the method link second.
  const actionLink = variant === 'confirm' ? methodLink! : buildPublicInvoiceUrl((await getOrMintInvoiceLink(invoice!, tx)).token);
  const secondaryAction: PaymentSecondaryAction | undefined = variant === 'update' || returnedUnusable ? updateMethodAction(methodLink!) : undefined;
  // Name the retry only when this attempt's schedule really holds one (retryAt is null
  // after the last soft/NSF retry, for hard failures and for unscheduled attempts).
  const [schedule] = variant === 'pay' && attempt.scheduleId ? await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.id, attempt.scheduleId)).limit(1) : [];
  const retryOn = schedule && schedule.id === attempt.scheduleId && schedule.state === 'retry_scheduled'
    && schedule.attemptCount === attempt.attemptNo && schedule.nextAttemptAt ? schedule.nextAttemptAt.toISOString().slice(0, 10) : null;
  const noRetry = NO_AUTOMATIC_RETRY;
  const methodLabel = method ? formatPaymentMethod(method) : null;
  const money = (amount: string) => `${attempt.currency} ${amount}`;
  const feeMinor = toMinorUnits(attempt.feeAmount, attempt.currency);
  const attempted = fromMinorUnits(toMinorUnits(attempt.principalAmount, attempt.currency) + feeMinor, attempt.currency);
  // The confirm link leads to the invoice page, which collects the invoice balance with
  // no autopay fee, so the email states both amounts instead of contradicting itself (D-23).
  const confirmText = `We tried to charge ${money(attempted)}${feeMinor > 0
    ? ` (${money(attempt.principalAmount)} plus a ${money(attempt.feeAmount)} processing fee)` : ''} to your ${
    methodLabel ? paymentMethodInSentence(methodLabel) : 'saved payment method'} for invoice ${invoice!.invoiceNumber} as an automatic payment, and your bank asked you to confirm it first. Nothing has been charged. Confirming takes you to the invoice, where the amount due is ${invoice!.currencyCode} ${invoice!.balance}.`;
  const retryText = retryOn ? `Automatic payment will try again on or after ${retryOn} unless this invoice is paid or its automatic payment is stopped first. You can pay now instead.` : noRetry;
  const failureText = variant === 'expired' ? 'Your payment confirmation link expired. The pending payment was canceled. Please pay this invoice using the invoice link.'
    : variant === 'returned' ? `Your bank returned a previously completed payment. The invoice balance has reopened. ${returnedUnusable
      ? `Your bank also reported that your ${paymentMethodInSentence(methodLabel!)} can no longer be used for automatic payments. Please pay this invoice now.`
      : 'Please review the invoice and arrange payment.'}`
    : variant === 'confirm' ? confirmText
    : variant === 'update' ? `This payment method cannot be used for automatic payments, so this payment did not go through. ${noRetry}`
    : `${attempt.failureClass === 'nsf' ? 'The bank reported insufficient available funds.' : 'Payment could not be completed.'} ${retryText}`;
  const vars = { org_name: org!.name, partner_name: partner!.name, invoice_number: invoice!.invoiceNumber!,
    amount_due: `${invoice!.currencyCode} ${invoice!.balance}`, failure_text: failureText,
    action_link: actionLink, action_label: variant === 'confirm' ? 'Confirm payment' : 'Pay invoice',
    payment_method: methodLabel ?? 'Saved payment method', attempted_amount: money(attempted) };
  const rendered = await renderBillingNotice('payment_failed', { payment: { id: 'payment_failed', vars, secondaryAction,
    custom: partnerEmailCustomFromSettings(partner!.settings, 'payment_failed'), frozen: { attemptId, variant, tokenId, returnIdentity: returnIdentity ?? null,
      invoiceNumber: invoice!.invoiceNumber ?? null, partnerName: partner!.name, methodLabel,
      currency: attempt.currency, attemptedAmount: attempted, attemptFee: attempt.feeAmount, payNowAmount: invoice!.balance } } });
  await enqueueBillingNotice(tx, { orgId: attempt.orgId, partnerId: invoice!.partnerId, invoiceId: invoice!.id,
    kind: 'payment_failed', seq: 1, dedupeKey, toEmail: email, rendered });
}

export function attentionDedupeKey(attemptId: string,event: string,returnIdentity?: string): string {
  return `autopay:${attemptId}:${event}${returnIdentity ? `:${returnIdentity}` : ''}`;
}
export async function notifyPaymentAttention(input: {
  partnerId: string; orgId: string; invoiceId: string; attemptId: string; returnIdentity?: string; message?: string;
  event: 'payment.failed_final' | 'payment.ach_returned' | 'payment.unapplied' | 'autopay.needs_attention';
}): Promise<void> {
  if (input.event === 'payment.ach_returned' && !input.returnIdentity) throw new Error('Returned payment identity missing');
  const message = input.event === 'payment.unapplied'
    ? 'Stripe collected money that could not be applied. Review the payment and refund it in Stripe if appropriate.'
    : input.event === 'payment.ach_returned' ? 'A bank payment was returned. The invoice balance has reopened.'
    : input.event === 'payment.failed_final' ? 'Automatic payment has stopped retrying. The client can pay the invoice directly.'
    : 'Automatic payment needs attention. Review the invoice before trying again.';
  try { await sendAutopayStaffEmail({partnerId:input.partnerId,orgId:input.orgId,event:input.event,invoiceId:input.invoiceId,
    dedupeKey:attentionDedupeKey(input.attemptId,input.event,input.returnIdentity),
    message:input.message ?? `${message} Invoice: ${input.invoiceId}; attempt: ${input.attemptId}`});
  } catch(error) {
    reportCollectionError(error,{org_id:input.orgId,invoice_id:input.invoiceId,attempt_id:input.attemptId,
      autopay_phase:'staff_email',...(input.returnIdentity?{return_identity:input.returnIdentity}:{})});
  }
}

/** A due schedule failed because the org's shared autopay method became unusable
 * (a sibling invoice's hard decline or detach, or failed bank verification). It has
 * no attempt of its own, so this is the client's one notice for the invoice, in the
 * update-method variant.
 * Caller holds the invoice lock in the transaction that failed the schedule.
 */
export async function enqueueMethodUnusableNotice(tx: Tx, scheduleId: string): Promise<void> {
  await enqueueScheduleFailureNotice(tx, scheduleId, 'update');
}
/** Re-issue (2b-1) of the schedule-bound update email after its update link stopped being
 * true before dispatch: the invoice still was not charged, so the pay variant goes instead. */
export async function enqueueMethodUnusablePayNotice(tx: Tx, scheduleId: string): Promise<void> {
  await enqueueScheduleFailureNotice(tx, scheduleId, 'pay');
}
async function enqueueScheduleFailureNotice(tx: Tx, scheduleId: string, variant: 'update' | 'pay'): Promise<void> {
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, scheduleId)).limit(1);
  if (!schedule?.enrollmentId) throw new Error('Schedule not found for notice');
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, schedule.invoiceId)).limit(1).for('update');
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, schedule.orgId)).limit(1);
  if (!invoice) throw new Error('Invoice not found for notice');
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  if (!org || !partner || invoice.orgId !== schedule.orgId || org.id !== invoice.orgId || org.partnerId !== invoice.partnerId) {
    throw new Error('Payment notice ownership mismatch');
  }
  const email = resolveBillingEmail(org.billingContact);
  if (!email) return;
  const dedupeKey = noticeDedupeKey(invoice.id, variant === 'update' ? 'payment_failed:method_not_usable' : 'payment_failed:method_not_usable:pay');
  const [existingNotice] = await tx.select({id:billingNoticeOutbox.id}).from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.dedupeKey,dedupeKey)).limit(1);
  if (existingNotice) return;
  let secondaryAction: PaymentSecondaryAction | undefined;
  let tokenId: string | null = null;
  if (variant === 'update') {
    const [enrollment] = await tx.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
    // A stopped or re-requested enrollment cannot mint an update-method link.
    if (!enrollment || enrollment.orgId !== invoice.orgId || enrollment.status !== 'active'
      || enrollment.generation !== schedule.enrollmentGeneration) return;
    // Same 'update' layout as enqueueAttemptNotice (pay this invoice first, update link
    // second), frozen to the schedule instead of an attempt (validatePaymentActionNotice
    // has a schedule-bound branch). No attempt was made for this invoice.
    const token = await mintBillingLinkToken(tx, { orgId: invoice.orgId, invoiceId: invoice.id,
      enrollmentId: enrollment.id, generation: enrollment.generation, purpose: 'enroll', ttlDays: 14 });
    tokenId = token.id;
    secondaryAction = updateMethodAction(buildBillingLinkUrl('enroll', token.token));
  }
  const vars = { org_name: org.name, partner_name: partner.name, invoice_number: invoice.invoiceNumber!,
    amount_due: `${invoice.currencyCode} ${invoice.balance}`,
    failure_text: variant === 'update'
      ? `Your saved payment method can no longer be used for automatic payments, so this invoice was not charged automatically. ${NO_AUTOMATIC_RETRY}`
      : `Your saved payment method could not be used, so this invoice was not charged automatically. ${NO_AUTOMATIC_RETRY}`,
    action_link: buildPublicInvoiceUrl((await getOrMintInvoiceLink(invoice, tx)).token), action_label: 'Pay invoice' };
  const rendered = await renderBillingNotice('payment_failed', { payment: { id: 'payment_failed', vars, secondaryAction,
    custom: partnerEmailCustomFromSettings(partner.settings, 'payment_failed'),
    frozen: { attemptId: null, scheduleId: schedule.id, variant, tokenId, returnIdentity: null,
      invoiceNumber: invoice.invoiceNumber ?? null, partnerName: partner.name } } });
  await enqueueBillingNotice(tx, { orgId: invoice.orgId, partnerId: invoice.partnerId, invoiceId: invoice.id,
    kind: 'payment_failed', seq: 1, dedupeKey, toEmail: email, rendered });
}
