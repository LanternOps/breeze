import { reportCollectionError } from './collectionErrors';
import { eq } from 'drizzle-orm';
import { invoiceCollectionAttempts, invoiceStripePayments, invoices, organizations, partners, orgPaymentMethods, orgAutopayEnrollments, billingNoticeOutbox } from '../../db/schema';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { resolveBillingEmail } from '../invoicePdf';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import { mintBillingLinkToken, buildBillingLinkUrl } from './linkTokens';
import { enqueueBillingNotice } from './noticeOutbox';
import { renderBillingNotice } from './renderBillingNotice';
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
  const vars = { org_name: org!.name, partner_name: partner!.name, invoice_number: invoice!.invoiceNumber!,
    amount_paid: `${mapping.currency} ${mapping.amount}`, fee_amount: `${mapping.currency} ${mapping.feeAmount}`,
    total_charged: `${mapping.currency} ${total}`, payment_method: mapping.paymentMethodType === 'us_bank_account' ? 'Bank debit' : 'Card',
    paid_on: mapping.paymentReceivedAt!, balance_remaining: `${invoice!.currencyCode} ${invoice!.balance}` };
  const rendered = await renderBillingNotice('payment_receipt', { payment: { id: 'payment_receipt', vars,
    custom: partnerEmailCustomFromSettings(partner!.settings, 'payment_receipt'),
    frozen: { amount: mapping.amount, fee: mapping.feeAmount, total } } });
  await enqueueBillingNotice(tx, { orgId: mapping.orgId, partnerId: invoice!.partnerId, invoiceId: invoice!.id,
    kind: 'payment_receipt', seq: 1, dedupeKey: noticeDedupeKey(mapping.id, 'payment_receipt'), toEmail: email, rendered });
}
export async function enqueueAttemptNotice(tx: Tx, attemptId: string,
  variant: 'receipt' | 'confirm' | 'update' | 'pay' | 'returned' | 'expired', returnIdentity?: string): Promise<void> {
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
  const dedupeKey = variant === 'returned' ? returnedNoticeDedupeKey(attemptId,returnIdentity!)
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
  let tokenId: string | null = null;
  let actionLink: string;
  if (variant === 'pay' || variant === 'returned' || variant === 'expired') actionLink = buildPublicInvoiceUrl((await getOrMintInvoiceLink(invoice!, tx)).token);
  else {
    const token = await mintBillingLinkToken(tx, { orgId: attempt.orgId, invoiceId: invoice!.id,
      enrollmentId: method!.enrollmentId, generation: enrollment!.generation, purpose: variant === 'confirm' ? 'confirm_payment' : 'enroll', ttlDays: 14 });
    tokenId = token.id;
    actionLink = buildBillingLinkUrl(variant === 'confirm' ? 'confirm_payment' : 'enroll', token.token);
  }
  const failureText = variant === 'expired' ? 'Your payment confirmation link expired. The pending payment was canceled. Please pay this invoice using the invoice link.'
    : variant === 'returned' ? 'Your bank returned a previously completed payment. The invoice balance has reopened. Please review the invoice and arrange payment.'
    : variant === 'confirm' ? 'Your bank requires confirmation before this payment can complete.'
    : variant === 'update' ? 'This payment method cannot be used. Please update it or pay this invoice.'
    : attempt.failureClass === 'nsf' ? 'The bank reported insufficient available funds. One retry may follow.'
    : 'Payment could not be completed. You can pay this invoice now.';
  const vars = { org_name: org!.name, partner_name: partner!.name, invoice_number: invoice!.invoiceNumber!,
    amount_due: `${invoice!.currencyCode} ${invoice!.balance}`, failure_text: failureText,
    action_link: actionLink, action_label: variant === 'confirm' ? 'Confirm payment' : variant === 'update' ? 'Update payment method' : 'Pay invoice' };
  const rendered = await renderBillingNotice('payment_failed', { payment: { id: 'payment_failed', vars,
    custom: partnerEmailCustomFromSettings(partner!.settings, 'payment_failed'), frozen: { attemptId, variant, tokenId, returnIdentity: returnIdentity ?? null } } });
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
