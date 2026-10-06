import { enqueueAutopayStaffNotifications } from './staffNotifications';
import { parseAutopayTerms, paymentMethodInSentence } from '@breeze/shared';
import { clientNameFor, emailDate, emailMoney } from './billingEmail';
import { collectionFenced } from './collectionControl';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { billingNoticeOutbox, invoiceAutopaySchedules, invoices,
  orgAutopayEnrollments, orgPaymentMethods, organizations, partners, stripeConnectAccounts } from '../../db/schema';
import type { AutopayPaymentMethodType, AccountHolderType } from '@breeze/shared';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import { emitInvoiceEvent } from '../invoiceEvents';
import { mintBillingLinkToken, buildBillingLinkUrl } from './linkTokens';
import { enqueueBillingNotice, registerNoticeSentHandler, registerNoticePreSendValidator, type NoticeSentHandler, type NoticePreSendValidator } from './noticeOutbox';
import { renderBillingNotice } from './renderBillingNotice';
import { addUtcDays, noticeLeadDays } from './scheduler';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { quoteProcessingFee } from './processingFee';
import { acceptedCollectionFee, collectionFeePolicyChanged } from './collectionFee';
import { fromMinorUnits, toMinorUnits } from '../stripeMoney';
import { AR_OPEN_STATUSES } from '../../db/schema/invoices';
import { isPublicLinkOrgStatusLive, isPublicLinkPartnerStatusLive } from '../publicLinkOrgGate';
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type { AutopayTerms } from '@breeze/shared';
export async function enqueueAutopayNotice(tx: Tx, scheduleId: string): Promise<void> {
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.id, scheduleId)).limit(1);
  if (!schedule?.eligible || !schedule.enrollmentId || schedule.state !== 'awaiting_notice') return;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, schedule.invoiceId)).limit(1);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, schedule.orgId)).limit(1);
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice!.partnerId)).limit(1);
  const contact = org?.billingContact as { email?: string } | null;
  if (!contact?.email) {
    await tx.update(invoiceAutopaySchedules).set({ stateReason: 'no_billing_contact' })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    await enqueueAutopayStaffNotifications(tx, {orgId:schedule.orgId,partnerId:invoice!.partnerId,invoiceId:invoice!.id,
      event:'autopay.needs_attention',dedupeKey:`autopay:${schedule.id}:no_billing_contact`,message:'The automatic payment notice is blocked: the client has no billing contact. Delivery will be retried when a contact is added.'});
    return;
  }
  const terms = parseAutopayTerms(schedule.termsSnapshot);
  const seq = terms.noticeSeq;
  const existing = await tx.select({ id: billingNoticeOutbox.id }).from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.dedupeKey, `${invoice!.id}:invoice_autopay:${seq}`)).limit(1);
  if (existing[0]) return;
  // F-2: a bank still waiting for microdeposit verification can't be charged on the date, so
  // the notice says what to do (verify it, or pay another way), never "nothing to do".
  const [noticedMethod] = await tx.select({ status: orgPaymentMethods.status }).from(orgPaymentMethods)
    .where(and(eq(orgPaymentMethods.id, terms.methodId), eq(orgPaymentMethods.orgId, schedule.orgId))).limit(1);
  const awaitingVerification = noticedMethod?.status === 'pending_verification';
  const skip = await mintBillingLinkToken(tx, { orgId: schedule.orgId, invoiceId: schedule.invoiceId,
    enrollmentId: schedule.enrollmentId, generation: schedule.enrollmentGeneration,
    purpose: 'skip_invoice', ttlDays: 90 });
  const stop = await mintBillingLinkToken(tx, { orgId: schedule.orgId,
    enrollmentId: schedule.enrollmentId, generation: schedule.enrollmentGeneration,
    purpose: 'stop_autopay', ttlDays: 90 });
  const link = await getOrMintInvoiceLink(invoice!, tx);
  const total = fromMinorUnits(toMinorUnits(terms.principal, terms.currency) + toMinorUnits(terms.feeAmount, terms.currency), terms.currency);
  // One money and one date formatter everywhere (the notice used to mix "USD 100.00"
  // with "$103.00"). The method label was frozen with the terms by the canonical formatter.
  const methodLabel = terms.methodLabel;
  const chargeOn = emailDate(schedule.collectOn);
  const rendered = await renderBillingNotice('invoice_autopay', { charging: {
    vars: { org_name: org!.name, partner_name: partner!.name, client_name: clientNameFor(org!.billingContact, org!.name),
      invoice_number: invoice!.invoiceNumber!, amount_due: emailMoney(terms.principal, terms.currency),
      due_date: emailDate(invoice!.dueDate), charge_date: chargeOn,
      payment_method: paymentMethodInSentence(methodLabel), fee_amount: emailMoney(terms.feeAmount, terms.currency),
      charge_total: emailMoney(total, terms.currency), invoice_link: buildPublicInvoiceUrl(link.token) },
    custom: awaitingVerification ? null : partnerEmailCustomFromSettings(partner!.settings, 'invoice_autopay'),
    variant: awaitingVerification ? 'pending_verification' : undefined,
    skipUrl: buildBillingLinkUrl('skip_invoice', skip.token),
    stopUrl: buildBillingLinkUrl('stop_autopay', stop.token),
    methodLabel,
    // R12: the fee is a maximum (a debit or prepaid card pays none), so the total is "up to", as in the facts table.
    feeVaries: terms.feeKind === 'card_percent',
    preheader: awaitingVerification ? 'Verify your bank account so this invoice can be paid automatically.'
      : toMinorUnits(terms.feeAmount, terms.currency) > 0 && terms.feeKind === 'card_percent'
      ? `Up to ${emailMoney(total, terms.currency)} will be charged on or around ${chargeOn}.`
      // FP-16: a flat fee is exact.
      : `${emailMoney(toMinorUnits(terms.feeAmount, terms.currency) > 0 ? total : terms.principal, terms.currency)} will be charged on or around ${chargeOn}.`,
    authorizationText: terms.methodType === 'us_bank_account'
      ? `You authorized this debit when you set up automatic payments with ${partner!.name}. The payment date is when the debit starts; your bank decides when it settles.`
      : `You authorized this payment when you set up automatic payments with ${partner!.name}.`,
    frozen: { enqueuedAt: new Date().toISOString(), amount: terms.principal, fee: terms.feeAmount, chargeDate: schedule.collectOn,
      methodType: terms.methodType, enrollmentGeneration: schedule.enrollmentGeneration,
      invoiceNumber: invoice!.invoiceNumber ?? null, partnerName: partner!.name, methodLabel, total },
  } }, tx);
  const outbox = await enqueueBillingNotice(tx, { orgId: schedule.orgId, partnerId: invoice!.partnerId,
    invoiceId: invoice!.id, enrollmentId: schedule.enrollmentId, kind: 'invoice_autopay', seq,
    dedupeKey: `${invoice!.id}:invoice_autopay:${seq}`, toEmail: contact.email, rendered });
  await tx.update(invoiceAutopaySchedules).set({ noticeOutboxId: outbox.id,
    noticeSentAt: null, stateReason: null }).where(eq(invoiceAutopaySchedules.id, schedule.id));
}
export const invoiceAutopayNoticeSent: NoticeSentHandler = async (tx, row) => {
  if (!row.invoiceId || !row.sentAt) return;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, row.invoiceId)).limit(1).for('update');
  if (!invoice || ['void', 'paid', 'draft'].includes(invoice.status)) return;
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.noticeOutboxId, row.id),
  )).limit(1).for('update');
  if (!schedule?.enrollmentId || schedule.state !== 'awaiting_notice') return;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
  if (collectionFenced({ schedule, invoice, enrollment }) || !enrollment || enrollment.orgId !== invoice.orgId || enrollment.status !== 'active'
    || enrollment.generation !== schedule.enrollmentGeneration) return;
  const terms = parseAutopayTerms(schedule.termsSnapshot);
  // collectOn is a calendar selection date. Collection must also enforce the
  // full elapsed lead from this exact noticeSentAt, including non-midnight sends.
  // Keep the rendered chargeDate frozen as the recipient saw it.
  const earliest = addUtcDays(row.sentAt.toISOString().slice(0, 10), terms.noticeLeadDays);
  await tx.update(invoiceAutopaySchedules).set({ noticeSentAt: row.sentAt, state: 'scheduled',
    collectOn: schedule.collectOn! > earliest ? schedule.collectOn : earliest,
  }).where(eq(invoiceAutopaySchedules.id, schedule.id));
  const changed = await tx.update(invoices).set({ sentAt: row.sentAt })
    .where(and(eq(invoices.id, invoice.id), isNull(invoices.sentAt))).returning({ id: invoices.id });
  if (changed.length) await emitInvoiceEvent({ type: 'invoice.sent', invoiceId: invoice.id,
    orgId: invoice.orgId, partnerId: invoice.partnerId, actorUserId: null });
};

/** Validate queued mail against current authority immediately before transport. */
const validateAutopayNotice: NoticePreSendValidator = async (tx, row) => {
  const obsolete = 'Automatic payment notice no longer current';
  if (!row.invoiceId || !row.enrollmentId) return obsolete;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, row.invoiceId)).limit(1).for('update');
  if (!invoice || invoice.orgId !== row.orgId || !AR_OPEN_STATUSES.includes(invoice.status as typeof AR_OPEN_STATUSES[number])
    || invoice.autopayExcluded || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0) return obsolete;
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(and(eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.noticeOutboxId, row.id)))
    .limit(1).for('update');
  if (!schedule?.enrollmentId || !schedule.eligible || schedule.state !== 'awaiting_notice'
    || schedule.orgId !== row.orgId || schedule.noticeOutboxId !== row.id || schedule.enrollmentId !== row.enrollmentId) return obsolete;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
  if (collectionFenced({ schedule, invoice, enrollment }) || !enrollment || enrollment.orgId !== row.orgId || enrollment.partnerId !== invoice.partnerId
    || enrollment.status !== 'active' || enrollment.generation !== schedule.enrollmentGeneration) return obsolete;
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, row.orgId)).limit(1);
  if (!org || org.partnerId !== invoice.partnerId || org.deletedAt || !isPublicLinkOrgStatusLive(org.status)) return obsolete;
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  if (!partner || partner.deletedAt || !isPublicLinkPartnerStatusLive(partner.status) || !partner.autopayEnabled) return obsolete;
  const terms = parseAutopayTerms(schedule.termsSnapshot);
  const frozen = (row.rendered as { frozen?: Record<string, unknown> }).frozen;
  if (!terms || terms.noticeSeq !== row.seq || terms.currency !== invoice.currencyCode
    || frozen?.amount !== terms.principal || frozen.fee !== terms.feeAmount
    || frozen.chargeDate !== schedule.collectOn || frozen.methodType !== terms.methodType
    || frozen.enrollmentGeneration !== schedule.enrollmentGeneration) return obsolete;
  const [method] = await tx.select().from(orgPaymentMethods).where(and(
    eq(orgPaymentMethods.orgId, row.orgId), eq(orgPaymentMethods.isAutopayMethod, true),
    inArray(orgPaymentMethods.status, ['active', 'pending_verification']),
  )).limit(1);
  if (!method || method.orgId !== row.orgId || method.enrollmentId !== enrollment.id || !method.isAutopayMethod
    || !['active', 'pending_verification'].includes(method.status)
    || method.id !== terms.methodId || method.type !== terms.methodType
    || (method.type === 'us_bank_account' && method.accountHolderType === null)
    || method.accountHolderType !== terms.accountHolderType || noticeLeadDays(method) !== terms.noticeLeadDays) return obsolete;
  const settings = await resolveBillingPaymentSettings(tx, { partnerId: invoice.partnerId, orgId: row.orgId });
  const [connection] = await tx.select().from(stripeConnectAccounts).where(and(
    eq(stripeConnectAccounts.id, enrollment.stripeConnectionId), eq(stripeConnectAccounts.partnerId, invoice.partnerId),
  )).limit(1);
  if (!connection) return obsolete;
  const lawfulFee = quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
    principal: terms.principal, currency: terms.currency, stripeAccountCountry: connection.accountCountry,
    orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
    cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value, feeAttested: settings.feeAttested });
  const fee = await acceptedCollectionFee(tx, {orgId:invoice.orgId,partnerId:invoice.partnerId,
    enrollmentId:enrollment.id,generation:enrollment.generation,methodId:method.id,methodType:method.type,
    principal:terms.principal,currency:terms.currency,quote:lawfulFee});
  if (!fee || collectionFeePolicyChanged(terms, {cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value}, fee)
    || fee.kind !== terms.feeKind || toMinorUnits(fee.feeAmount, terms.currency) !== toMinorUnits(terms.feeAmount, terms.currency)) return obsolete;
  return null;
};

let handlersRegistered = false;
export function registerAutopayNoticeHandlers(): void {
  if (handlersRegistered) return;
  registerNoticeSentHandler('invoice_autopay', invoiceAutopayNoticeSent);
  registerNoticePreSendValidator('invoice_autopay', validateAutopayNotice);
  handlersRegistered = true;
}
