import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, invoiceLines, contracts, organizations, orgAutopayEnrollments, orgPaymentMethods,
  invoiceAutopaySchedules, invoiceCollectionAttempts, invoiceStripePayments, billingNoticeOutbox } from '../../db/schema';
import type { CollectionAttemptInitiator } from '@breeze/shared';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import type Stripe from 'stripe';
import { getPartnerStripeClient } from '../partnerStripe';
import { InvoiceServiceError } from '../invoiceTypes';
import { enqueueAutopayStaffNotifications } from './staffNotifications';
import { lockInvoiceForCollection } from './reservation';
import { getAutopayMethod } from './paymentMethods';
import { isAutopayEnabledForPartner } from './autopayGate';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { quoteProcessingFee } from './processingFee';
import { noticeLeadDays, computeCollectOn } from './scheduler';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
export type CollectionInput = { invoiceId: string; initiatedBy: CollectionAttemptInitiator; scheduleId?: string };
export type CollectionResult = { attemptId: string | null; outcome: 'created' | 'deferred' | 'refused'; reason?: string };
export function collectionNoticeAllows(sentAt: Date | null, lead: number, now: Date): boolean {
  return !!sentAt && now.getTime() >= sentAt.getTime() + lead * 86_400_000;
}

const defer = (reason: string): CollectionResult => ({ attemptId: null, outcome: 'deferred', reason });
const refuse = (reason: string): CollectionResult => ({ attemptId: null, outcome: 'refused', reason });
const CARD_NETWORKS = new Set(['visa', 'mastercard', 'amex', 'discover', 'diners', 'jcb', 'unionpay', 'cartes_bancaires']);
type Method = typeof orgPaymentMethods.$inferSelect;
type Enrollment = typeof orgAutopayEnrollments.$inferSelect;

/** Stored brand alone cannot distinguish a Link wallet from a reusable card. */
function admittedMethod(live: Stripe.PaymentMethod, method: Method, enrollment: Enrollment): boolean {
  const customerId = typeof live.customer === 'string' ? live.customer : live.customer?.id;
  if (live.id !== method.stripePaymentMethodId || customerId !== enrollment.stripeCustomerId
    || live.type !== method.type) return false;
  if (live.type === 'us_bank_account') {
    return !!live.us_bank_account && live.us_bank_account.account_holder_type === method.accountHolderType;
  }
  const card = live.card;
  return !!card && card.wallet?.type !== 'link' && CARD_NETWORKS.has(card.brand)
    && !!card.networks?.available.length && card.networks.available.every(network => CARD_NETWORKS.has(network))
    && (!card.networks.preferred || CARD_NETWORKS.has(card.networks.preferred))
    && card.funding === method.cardFunding;
}

async function prepareMethodAdmission(invoiceId: string) {
  const snapshot = await withSystemDbAccessContext(async () => {
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    if (!['sent', 'partially_paid', 'overdue'].includes(invoice.status)) return refuse('not_payable');
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
    if (!enrollment || enrollment.status !== 'active' || enrollment.partnerId !== invoice.partnerId
      || enrollment.orgId !== invoice.orgId) return refuse('enrollment_inactive');
    if (!await isAutopayEnabledForPartner(db, invoice.partnerId)) return refuse('charging_disabled');
    const readiness = await getAutopayStripeReadiness(db, invoice.partnerId);
    if (!readiness.ready || readiness.stripeAccountId !== enrollment.stripeAccountId) return refuse('stripe_unavailable');
    const method = await getAutopayMethod(db, invoice.orgId);
    if (!method || method.status !== 'active' || !method.isAutopayMethod || method.orgId !== invoice.orgId
      || method.enrollmentId !== enrollment.id || !enrollment.stripeCustomerId) return defer('method_not_usable');
    if (method.type === 'us_bank_account' && (invoice.currencyCode !== 'USD' || !method.accountHolderType)) {
      return refuse('ach_currency_unsupported');
    }
    return { invoice, enrollment, method };
  }, 'autopay.admission');
  if ('outcome' in snapshot) return snapshot;
  try {
    // The factory only reads credentials; close its short context before HTTP.
    const provider = await withSystemDbAccessContext(() => getPartnerStripeClient(snapshot.invoice.partnerId));
    if (provider.stripeAccountId !== snapshot.enrollment.stripeAccountId) return refuse('stripe_unavailable');
    const live = await runOutsideDbContext(() => provider.stripe.paymentMethods.retrieve(snapshot.method.stripePaymentMethodId));
    return { ...snapshot, live };
  } catch {
    // A transient lookup failure is not evidence that the saved method is bad.
    return defer('stripe_unavailable');
  }
}

/** Internal reservation stage. Callers must authorize invoice scope first and
 * finish Checkout revocation outside a held context (Task 11 orchestration).
 * The locked mapping recheck below is mandatory even after successful revocation.
 */
export async function reserveCollection(input: CollectionInput)
  : Promise<CollectionResult | { attempt: typeof invoiceCollectionAttempts.$inferSelect }> {
  assertNoHeldDbContextForStripe('reserveCollection');
  const admission = await prepareMethodAdmission(input.invoiceId);
  if ('outcome' in admission) return admission;
  return withSystemDbAccessContext(async () => {
    const locked = await lockInvoiceForCollection(db, input.invoiceId);
    const invoice = locked.invoice;
    if (!['sent','partially_paid','overdue'].includes(invoice.status)) return refuse('not_payable');
    if (toMinorUnits(locked.unreservedBalance, invoice.currencyCode) <= 0) return refuse('nothing_to_pay');
    if (toMinorUnits(locked.reservedAmount, invoice.currencyCode) > 0) return defer('collection_in_progress');
    const [unrevoked] = await db.select({ id: invoiceStripePayments.id }).from(invoiceStripePayments).where(and(
      eq(invoiceStripePayments.invoiceId, invoice.id), eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'), isNull(invoiceStripePayments.invoicePaymentId),
      sql`${invoiceStripePayments.revocationState} <> 'revoked'`,
    )).limit(1);
    if (unrevoked) return defer('checkout_session_unrevoked');
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1).for('update');
    if (!enrollment || enrollment.status !== 'active' || enrollment.orgId !== invoice.orgId
      || enrollment.partnerId !== invoice.partnerId) return refuse('enrollment_inactive');
    if (!await isAutopayEnabledForPartner(db, invoice.partnerId)) return refuse('charging_disabled');
    const readiness = await getAutopayStripeReadiness(db, invoice.partnerId);
    if (!readiness.ready || readiness.stripeAccountId !== enrollment.stripeAccountId) return refuse('stripe_unavailable');
    const method = await getAutopayMethod(db, invoice.orgId);
    if (!method || method.status !== 'active' || !method.isAutopayMethod || method.orgId !== invoice.orgId
      || method.enrollmentId !== enrollment.id) return defer('method_not_usable');
    // A live response authorizes only the exact identity read before HTTP. A
    // concurrent replacement, stop/re-enroll or account change must retry.
    if (invoice.orgId !== admission.invoice.orgId || invoice.partnerId !== admission.invoice.partnerId
      || enrollment.id !== admission.enrollment.id || enrollment.generation !== admission.enrollment.generation
      || enrollment.stripeAccountId !== admission.enrollment.stripeAccountId
      || enrollment.stripeCustomerId !== admission.enrollment.stripeCustomerId
      || method.id !== admission.method.id || method.stripePaymentMethodId !== admission.method.stripePaymentMethodId
      || method.type !== admission.method.type || method.accountHolderType !== admission.method.accountHolderType
      || method.cardFunding !== admission.method.cardFunding) return defer('method_not_usable');
    if (!admittedMethod(admission.live, method, enrollment)) {
      await db.update(orgAutopayEnrollments).set({ needsAttentionReason: 'method_unusable' })
        .where(eq(orgAutopayEnrollments.id, enrollment.id));
      await enqueueAutopayStaffNotifications(db, { orgId: invoice.orgId, partnerId: invoice.partnerId,
        event: 'autopay.needs_attention',
        dedupeKey: `autopay_method_admission_${enrollment.id}_${enrollment.generation}_${method.id}`,
        message: 'Automatic payments need a supported payment method. Review the saved payment method.',
      });
      return defer('method_not_usable');
    }
    if (method.type === 'us_bank_account' && (invoice.currencyCode !== 'USD' || !method.accountHolderType)) {
      return refuse('ach_currency_unsupported');
    }
    const [schedule] = input.scheduleId ? await db.select().from(invoiceAutopaySchedules).where(and(
      eq(invoiceAutopaySchedules.id, input.scheduleId), eq(invoiceAutopaySchedules.invoiceId, invoice.id),
      eq(invoiceAutopaySchedules.orgId, invoice.orgId),
    )).limit(1).for('update') : [];
    if (input.initiatedBy !== 'client_on_session' && !schedule) return refuse('schedule_required');
    if (input.initiatedBy === 'client_on_session' && input.scheduleId) return refuse('unexpected_schedule');
    if (schedule && (schedule.id !== input.scheduleId || schedule.invoiceId !== invoice.id || schedule.orgId !== invoice.orgId
      || !schedule.enrollmentId || schedule.enrollmentId !== enrollment.id
      || !schedule.eligible || !['scheduled','retry_scheduled'].includes(schedule.state)
      || schedule.enrollmentGeneration !== enrollment.generation || invoice.autopayExcluded
      || schedule.clientSkippedAt || schedule.mspExcludedAt)) return refuse('schedule_inactive');
    if (schedule) {
      const [excluded] = await db.select({ id: contracts.id }).from(invoiceLines).innerJoin(contracts,
        and(eq(invoiceLines.sourceContractId, contracts.id), eq(invoiceLines.orgId, contracts.orgId)))
        .where(and(eq(invoiceLines.invoiceId, invoice.id), eq(contracts.autopayExcluded, true))).limit(1);
      if (excluded) {
        await db.update(invoiceAutopaySchedules).set({ state: 'excluded_by_msp', stateReason: 'excluded_contract' })
          .where(eq(invoiceAutopaySchedules.id, schedule.id));
        return refuse('excluded_contract');
      }
    }
    const settings = await resolveBillingPaymentSettings(db, { partnerId: invoice.partnerId, orgId: invoice.orgId });
    const [org] = await db.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
    const terms = schedule?.termsSnapshot as AutopayTerms | undefined;
    if (!org || org.partnerId !== invoice.partnerId) return refuse('enrollment_inactive');
    if (schedule && (!terms || terms.currency !== invoice.currencyCode)) return refuse('schedule_inactive');
    const principalMinor = terms ? Math.min(toMinorUnits(locked.unreservedBalance, invoice.currencyCode),
      toMinorUnits(terms.principal, invoice.currencyCode)) : toMinorUnits(locked.unreservedBalance, invoice.currencyCode);
    const principal = fromMinorUnits(principalMinor, invoice.currencyCode);
    if (principalMinor <= 0) return refuse('nothing_to_pay');
    const quote = quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
      principal, currency: invoice.currencyCode, stripeAccountCountry: readiness.accountCountry,
      orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
      cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value, feeAttested: settings.feeAttested });
    if (terms && (terms.methodType !== method.type || terms.noticeLeadDays !== noticeLeadDays(method)
      || terms.methodId !== method.id || terms.accountHolderType !== method.accountHolderType
      || terms.cardFeeBps !== settings.cardFeeBps.value || terms.achFeeAmount !== settings.achFeeAmount.value
      || toMinorUnits(quote.feeAmount, invoice.currencyCode) > toMinorUnits(terms.feeAmount, invoice.currencyCode))) {
      const collectOn = computeCollectOn({ issueDate: invoice.issueDate!, dueDate: invoice.dueDate!,
        offsetDays: terms.offsetDays, rule: terms.rule, noticeDate: new Date().toISOString().slice(0,10),
        leadDays: noticeLeadDays(method) });
      await db.update(invoiceAutopaySchedules).set({ state: 'awaiting_notice', noticeSentAt: null,
        noticeOutboxId: null, collectOn, termsSnapshot: { ...terms, methodId: method.id, methodType: method.type,
          last4: method.cardLast4 ?? method.bankLast4 ?? '',
          methodLabel: `${method.cardBrand ?? method.bankName ?? 'Payment method'} ••${method.cardLast4 ?? method.bankLast4 ?? ''}`,
          accountHolderType: method.accountHolderType, noticeLeadDays: noticeLeadDays(method),
          principal, feeAmount: quote.feeAmount, feeKind: quote.kind, cardFeeBps: settings.cardFeeBps.value,
          achFeeAmount: settings.achFeeAmount.value, chargeDate: collectOn, noticeSeq: terms.noticeSeq + 1 } })
        .where(eq(invoiceAutopaySchedules.id, schedule!.id));
      await enqueueAutopayNotice(db, schedule!.id);
      return defer('renotice_required');
    }
    if (schedule) {
      if (!schedule.noticeOutboxId || !collectionNoticeAllows(schedule.noticeSentAt, terms!.noticeLeadDays, new Date())) {
        return defer('notice_lead');
      }
      const [notice] = await db.select().from(billingNoticeOutbox).where(and(
        eq(billingNoticeOutbox.id, schedule.noticeOutboxId), eq(billingNoticeOutbox.orgId, invoice.orgId),
        eq(billingNoticeOutbox.invoiceId, invoice.id), eq(billingNoticeOutbox.enrollmentId, enrollment.id),
      )).limit(1);
      const frozen = (notice?.rendered as { frozen?: Record<string, unknown> } | undefined)?.frozen;
      if (!notice || notice.id !== schedule.noticeOutboxId || notice.orgId !== invoice.orgId
        || notice.invoiceId !== invoice.id || notice.enrollmentId !== enrollment.id
        || notice.status !== 'sent' || notice.kind !== 'invoice_autopay' || notice.seq !== terms!.noticeSeq
        || notice.sentAt?.getTime() !== schedule.noticeSentAt!.getTime()
        || frozen?.amount !== terms!.principal || frozen.fee !== terms!.feeAmount
        || frozen.chargeDate !== terms!.chargeDate || frozen.methodType !== terms!.methodType
        || frozen.enrollmentGeneration !== enrollment.generation) return defer('notice_lead');
    }
    if (schedule?.state === 'retry_scheduled' && schedule.nextAttemptAt && schedule.nextAttemptAt > new Date()) return defer('retry_not_due');
    const feeMinor = Math.min(toMinorUnits(quote.feeAmount, invoice.currencyCode),
      terms ? toMinorUnits(terms.feeAmount, invoice.currencyCode) : Number.MAX_SAFE_INTEGER);
    const [ordinal] = await db.select({ n: sql<number>`coalesce(max(${invoiceCollectionAttempts.attemptNo}),0)::int` })
      .from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceId, invoice.id));
    const attemptNo = schedule ? schedule.attemptCount + 1 : (ordinal?.n ?? 0) + 1;
    const [attempt] = await db.insert(invoiceCollectionAttempts).values({ orgId: invoice.orgId,
      invoiceId: invoice.id, scheduleId: schedule?.id ?? null, attemptNo, paymentMethodId: method.id,
      idempotencyKey: schedule ? `autopay_${schedule.id}_${attemptNo}` : `autopay_client_${invoice.id}_${attemptNo}`,
      principalAmount: principal, feeAmount: fromMinorUnits(feeMinor, invoice.currencyCode),
      currency: invoice.currencyCode, state: 'reserved', initiatedBy: input.initiatedBy }).returning();
    if (schedule) await db.update(invoiceAutopaySchedules).set({ state: 'collecting', attemptCount: attemptNo })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    return { attempt: attempt! };
  }, 'autopay.reserve');
}
