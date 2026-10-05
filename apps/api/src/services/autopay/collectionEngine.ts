import { hasSupportedCardEvidence } from './feeDisclosure';
import { isCollectionProgrammingError, reportCollectionError } from './collectionErrors';
import { parseAutopayTerms } from '@breeze/shared';
import { resolveAttemptProvenance } from './attemptProvenance';
import {getClientPaymentAuthority} from './clientPaymentAuthority';
import {autopayConsentSnapshotSchema} from './types';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import { captureException } from '../sentry';
import { classifyCollectionFailure } from './failureClassifier';
import { retryAt } from './retryDates';
import { enqueueAttemptNotice, enqueueMethodUnusableNotice, notifyPaymentAttention } from './paymentNotices';
import { resolveMergedOrgIds } from '../orgMergeProvenance';
import { requestInvoiceSessionRevocation } from '../stripeSessionRevocation';
import { collectionFenced, finalizeInvoiceControl, isControllableSchedule, pendingInvoiceControl } from './collectionControl';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, invoiceLines, contracts, organizations, partners, orgAutopayEnrollments, orgPaymentMethods,
  invoiceAutopaySchedules, invoiceCollectionAttempts, invoiceStripePayments, billingNoticeOutbox, billingLinkTokens } from '../../db/schema';
import { RESERVING_COLLECTION_ATTEMPT_STATES, type CollectionAttemptInitiator } from '@breeze/shared';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
import { assertNoHeldDbContextForStripe, settlePaymentIntent } from '../stripeSettle';
import type Stripe from 'stripe';
import { getPartnerStripeClient } from '../partnerStripe';
import { InvoiceServiceError } from '../invoiceTypes';
import { enqueueAutopayStaffNotifications } from './staffNotifications';
import { lockInvoiceForCollection } from './reservation';
import { getAutopayMethod, markPaymentMethodUnusable } from './paymentMethods';
import { isAutopayEnabledForPartner } from './autopayGate';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { quoteProcessingFee } from './processingFee';
import { acceptedCollectionFee, clampNoticedFee, collectionFeePolicyChanged } from './collectionFee';
import { acceptedAutopayCap, autopayCapReason } from './authorizedCap';
import { noticeLeadDays, computeCollectOn, closeSettledAutopaySchedules } from './scheduler';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
export type CollectionInput = { invoiceId: string; initiatedBy: CollectionAttemptInitiator; scheduleId?: string };
import type { CollectionResult } from '@breeze/shared';
export type { CollectionResult } from '@breeze/shared';
export function collectionNoticeAllows(sentAt: Date | null, lead: number, now: Date): boolean {
  return !!sentAt && now.getTime() >= sentAt.getTime() + lead * 86_400_000;
}

const defer = (reason: string): CollectionResult => ({ attemptId: null, outcome: 'deferred', reason });
const refuse = (reason: string): CollectionResult => ({ attemptId: null, outcome: 'refused', reason });
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
  return !!card && hasSupportedCardEvidence(card) && card.funding === method.cardFunding;
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
    if (!await isAutopayEnabledForPartner(db, invoice.partnerId)) return defer('charging_disabled');
    const readiness = await getAutopayStripeReadiness(db, invoice.partnerId);
    if (!readiness.ready || readiness.stripeAccountId !== enrollment.stripeAccountId) return defer('stripe_unavailable');
    const method = await getAutopayMethod(db, invoice.orgId);
    if (!method || method.status !== 'active' || !method.isAutopayMethod || method.orgId !== invoice.orgId
      || method.enrollmentId !== enrollment.id || !enrollment.stripeCustomerId) return defer('method_not_usable');
    if (method.type === 'us_bank_account' && !method.accountHolderType) return defer('method_not_usable');
    if (method.type === 'us_bank_account' && invoice.currencyCode !== 'USD') return refuse('ach_currency_unsupported');
    return { invoice, enrollment, method };
  }, 'autopay.admission');
  if ('outcome' in snapshot) return snapshot;
  try {
    // The factory only reads credentials; close its short context before HTTP.
    const provider = await withSystemDbAccessContext(() => getPartnerStripeClient(snapshot.invoice.partnerId));
    if (provider.stripeAccountId !== snapshot.enrollment.stripeAccountId) return defer('stripe_unavailable');
    const live = await runOutsideDbContext(() => provider.stripe.paymentMethods.retrieve(snapshot.method.stripePaymentMethodId));
    return { ...snapshot, live };
  } catch (error) {
    reportCollectionError(error, {org_id:snapshot.invoice.orgId,invoice_id:invoiceId,autopay_method_id:snapshot.method.id,autopay_phase:'admission'});
    if (isCollectionProgrammingError(error)) throw error;
    const provider=error as {type?:string;code?:string};
    const missing=provider.code==='resource_missing';
    const credentials=['StripeAuthenticationError','StripePermissionError'].includes(provider.type ?? '')
      || ['INVALID_STRIPE_KEY','STRIPE_KEY_UNREADABLE','NO_STRIPE_KEY'].includes(provider.code ?? '');
    if (missing || credentials) await withSystemDbAccessContext(async()=>{
      if(missing)await markPaymentMethodUnusable(db,snapshot.method.id,'resource_missing');
      await enqueueAutopayStaffNotifications(db,{orgId:snapshot.invoice.orgId,partnerId:snapshot.invoice.partnerId,invoiceId,
        event:'autopay.needs_attention',dedupeKey:`autopay_admission:${snapshot.enrollment.id}:${snapshot.enrollment.generation}:${snapshot.method.id}:${missing?'missing':'credentials'}`,
        message:missing?'Automatic payment method is missing or detached. Update the saved method.':'Stripe credentials require attention before automatic payments can continue.'});
    },'autopay.admissionFailure');
    return defer(missing?'method_not_usable':'stripe_unavailable');
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
    if (toMinorUnits(locked.reservedAmount, invoice.currencyCode) > 0) return defer('collection_in_progress');
    if (toMinorUnits(locked.unreservedBalance, invoice.currencyCode) <= 0) return refuse('nothing_to_pay');
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
    if (!await isAutopayEnabledForPartner(db, invoice.partnerId)) return defer('charging_disabled');
    const readiness = await getAutopayStripeReadiness(db, invoice.partnerId);
    if (!readiness.ready || readiness.stripeAccountId !== enrollment.stripeAccountId) return defer('stripe_unavailable');
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
      if ((typeof admission.live.customer === 'string' ? admission.live.customer : admission.live.customer?.id) !== enrollment.stripeCustomerId) {
        await markPaymentMethodUnusable(db, method.id, 'payment_method_detached');
      }
      await db.update(orgAutopayEnrollments).set({ needsAttentionReason: 'method_unusable' })
        .where(eq(orgAutopayEnrollments.id, enrollment.id));
      await enqueueAutopayStaffNotifications(db, { orgId: invoice.orgId, partnerId: invoice.partnerId,
        event: 'autopay.needs_attention',
        dedupeKey: `autopay_method_admission_${enrollment.id}_${enrollment.generation}_${method.id}`,
        message: 'Automatic payments need a supported payment method. Review the saved payment method.',
      });
      return defer('method_not_usable');
    }
    if (method.type === 'us_bank_account' && !method.accountHolderType) return defer('method_not_usable');
    if (method.type === 'us_bank_account' && invoice.currencyCode !== 'USD') return refuse('ach_currency_unsupported');
    const [invoiceSchedule] = await db.select().from(invoiceAutopaySchedules)
      .where(and(eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.orgId, invoice.orgId)))
      .limit(1).for('update');
    if (collectionFenced({ schedule: invoiceSchedule, invoice: invoice, enrollment })) return refuse('schedule_inactive');
    const schedule = input.scheduleId ? invoiceSchedule : undefined;
    if (input.initiatedBy !== 'client_on_session' && !schedule) return refuse('schedule_required');
    if (input.initiatedBy === 'client_on_session' && input.scheduleId) return refuse('unexpected_schedule');
    if (schedule && (schedule.id !== input.scheduleId || schedule.invoiceId !== invoice.id || schedule.orgId !== invoice.orgId
      || !schedule.enrollmentId || schedule.enrollmentId !== enrollment.id
      || !schedule.eligible || !['scheduled','retry_scheduled'].includes(schedule.state)
      || schedule.enrollmentGeneration !== enrollment.generation)) return refuse('schedule_inactive');
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
    const terms = schedule ? parseAutopayTerms(schedule.termsSnapshot) : undefined;
    if (!org || org.partnerId !== invoice.partnerId || org.deletedAt || !['active','trial'].includes(org.status)) return refuse('enrollment_inactive');
    if (schedule && (!terms || terms.currency !== invoice.currencyCode)) return refuse('schedule_inactive');
    const principalMinor = terms ? Math.min(toMinorUnits(locked.unreservedBalance, invoice.currencyCode),
      toMinorUnits(terms.principal, invoice.currencyCode)) : toMinorUnits(locked.unreservedBalance, invoice.currencyCode);
    const principal = fromMinorUnits(principalMinor, invoice.currencyCode);
    if (principalMinor <= 0) return refuse('nothing_to_pay');
    const lawfulQuote = quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
      principal, currency: invoice.currencyCode, stripeAccountCountry: readiness.accountCountry,
      orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
      cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value, feeAttested: settings.feeAttested });
    const quote = input.initiatedBy === 'client_on_session' ? lawfulQuote : await acceptedCollectionFee(db, {
      orgId:invoice.orgId,partnerId:invoice.partnerId,enrollmentId:enrollment.id,generation:enrollment.generation,
      methodId:method.id,methodType:method.type,principal,currency:invoice.currencyCode,quote:lawfulQuote,
    });
    if (!quote) return refuse('consent_required');
    if (terms && (terms.methodType !== method.type || terms.noticeLeadDays !== noticeLeadDays(method)
      || terms.methodId !== method.id || terms.accountHolderType !== method.accountHolderType
      || collectionFeePolicyChanged(terms, {cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value}, quote)
      || toMinorUnits(quote.feeAmount, invoice.currencyCode) !== toMinorUnits(terms.feeAmount, invoice.currencyCode))) {
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
    const feeAmount = clampNoticedFee(quote, invoice.currencyCode, terms?.feeAmount);
    const feeMinor = toMinorUnits(feeAmount, invoice.currencyCode);
    const authority = input.initiatedBy === 'client_on_session' ? getClientPaymentAuthority() : undefined;
    let clientSetup: typeof autopaySetupAttempts.$inferSelect | undefined;
    if (input.initiatedBy === 'client_on_session') {
      if (!authority?.capture || authority.invoiceId !== invoice.id || authority.generation !== enrollment.generation
        || authority.methodId !== method.id || authority.currency !== invoice.currencyCode
        || method.type !== 'us_bank_account' || method.stripePaymentMethodId !== authority.capture.stripePaymentMethodId
        || method.stripeSetupIntentId !== authority.capture.setupIntentId
        || enrollment.stripeAccountId !== authority.capture.stripeAccountId
        || enrollment.stripeCustomerId !== authority.capture.stripeCustomerId
        // Exactly the accepted amount: a lower principal (a partial payment) or fee is a
        // changed term too, and the page offers the new total for a fresh acceptance (B1-1).
        || principalMinor !== toMinorUnits(authority.principal, invoice.currencyCode)
        || feeMinor !== toMinorUnits(authority.fee, invoice.currencyCode)) return refuse('client_authorization_required');
      [clientSetup] = await db.select().from(autopaySetupAttempts)
        .where(eq(autopaySetupAttempts.id, authority.capture.setupAttemptId)).limit(1).for('update');
      const accepted = autopayConsentSnapshotSchema.safeParse(clientSetup?.consentSnapshot);
      const bank = accepted.success ? accepted.data.bankPayment : null;
      if (!clientSetup || !bank || bank.invoiceId !== invoice.id || bank.orgId !== invoice.orgId
        || clientSetup.tokenId !== authority.tokenId || clientSetup.enrollmentId !== enrollment.id
        || clientSetup.generation !== enrollment.generation || clientSetup.outcome !== 'activated'
        || clientSetup.stripeAccountId !== enrollment.stripeAccountId || clientSetup.stripeCustomerId !== enrollment.stripeCustomerId
        || clientSetup.setupIntentId !== method.stripeSetupIntentId || bank.principal !== authority.principal
        || bank.fee !== authority.fee || bank.currency !== authority.currency) return refuse('client_authorization_required');
      const [used] = await db.select({ id: invoiceCollectionAttempts.id }).from(invoiceCollectionAttempts)
        .where(eq(invoiceCollectionAttempts.idempotencyKey, `autopay-bankpay:${clientSetup.id}`)).limit(1);
      if (used) return refuse('client_authorization_used');
      const consumed = await db.update(billingLinkTokens).set({ consumedAt: new Date() }).where(and(
        eq(billingLinkTokens.id, authority.tokenId), eq(billingLinkTokens.orgId, invoice.orgId),
        eq(billingLinkTokens.invoiceId, invoice.id), eq(billingLinkTokens.enrollmentId, enrollment.id),
        eq(billingLinkTokens.generation, enrollment.generation), eq(billingLinkTokens.purpose, 'enroll'),
        isNull(billingLinkTokens.consumedAt), isNull(billingLinkTokens.revokedAt), sql`${billingLinkTokens.expiresAt} > NOW()`,
      )).returning({ id: billingLinkTokens.id });
      if (!consumed.length) return refuse('client_authorization_used');
    }
    const [ordinal] = await db.select({ n: sql<number>`coalesce(max(${invoiceCollectionAttempts.attemptNo}),0)::int` })
      .from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceId, invoice.id));
    const attemptNo = schedule ? schedule.attemptCount + 1 : (ordinal?.n ?? 0) + 1;
    const [attempt] = await db.insert(invoiceCollectionAttempts).values({ orgId: invoice.orgId,
      invoiceId: invoice.id, scheduleId: schedule?.id ?? null, attemptNo, paymentMethodId: method.id,
      idempotencyKey: clientSetup ? `autopay-bankpay:${clientSetup.id}` : schedule ? `autopay_${schedule.id}_${attemptNo}` : `autopay_client_${invoice.id}_${attemptNo}`,
      principalAmount: principal, feeAmount,
      currency: invoice.currencyCode, state: 'reserved', initiatedBy: input.initiatedBy }).returning();
    if (schedule) await db.update(invoiceAutopaySchedules).set({ state: 'collecting', attemptCount: attemptNo })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    return { attempt: attempt! };
  }, 'autopay.reserve');
}

/** Human-readable PaymentIntent description for the MSP's Stripe dashboard. No statement
 * descriptor suffix is set: on a connected account it joins that account's own prefix
 * under a 22-character limit we cannot see, and a rejected create would block collection. */
export function paymentIntentDescription(invoiceNumber: string | null, partnerName: string | null): string {
  const text = [`Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''}`, partnerName?.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · ');
  return Array.from(text).slice(0, 500).join('');
}
export function paymentIntentCreateParams(attempt: typeof invoiceCollectionAttempts.$inferSelect,
  customer: string, method: string, partnerId: string, methodType: 'card' | 'us_bank_account',
  description?: string): Stripe.PaymentIntentCreateParams {
  const principal = toMinorUnits(attempt.principalAmount, attempt.currency);
  const fee = toMinorUnits(attempt.feeAmount, attempt.currency);
  return { amount: principal + fee, currency: attempt.currency.toLowerCase(), customer,
    payment_method: method, payment_method_types: [methodType], confirm: false,
    ...(description ? { description } : {}),
    metadata: { invoice_id: attempt.invoiceId, org_id: attempt.orgId, partner_id: partnerId,
      attempt_id: attempt.id, principal_minor: String(principal), fee_minor: String(fee) } };
}
async function loadAttemptRecord(attemptId: string) {
  const [attempt] = await db.select().from(invoiceCollectionAttempts)
    .where(eq(invoiceCollectionAttempts.id,attemptId)).limit(1);
  if (!attempt) throw new Error('Collection attempt not found');
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id,attempt.invoiceId)).limit(1);
  const [mapping] = attempt.invoiceStripePaymentId ? await db.select().from(invoiceStripePayments)
    .where(eq(invoiceStripePayments.id,attempt.invoiceStripePaymentId)).limit(1) : [];
  if (!invoice || invoice.orgId !== attempt.orgId) throw new Error('Attempt invoice mismatch');
  return {attempt,invoice,mapping};
}
// Only create/confirm and client-control paths may demand live collection authority.
export async function loadAttempt(attemptId: string) {
  return withSystemDbAccessContext(async () => {
    const data = await loadAttemptRecord(attemptId);
    if (!data.attempt.paymentMethodId) throw new Error('Collection authority cleared');
    const [method] = await db.select().from(orgPaymentMethods)
      .where(eq(orgPaymentMethods.id,data.attempt.paymentMethodId)).limit(1);
    if (!method) throw new Error('Collection authority missing');
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.id,method.enrollmentId)).limit(1);
    if (!enrollment || method.orgId !== data.invoice.orgId || enrollment.orgId !== data.invoice.orgId
      || enrollment.partnerId !== data.invoice.partnerId || !enrollment.stripeAccountId
      || !enrollment.stripeCustomerId) throw new Error('Collection authority mismatch');
    return {...data,method,enrollment:{...enrollment,stripeAccountId:enrollment.stripeAccountId,
      stripeCustomerId:enrollment.stripeCustomerId}};
  },'autopay.loadAuthority');
}
export async function loadAttemptForReconciliation(attemptId: string) {
  return withSystemDbAccessContext(async () => {
    const data = await loadAttemptRecord(attemptId);
    const m = data.mapping;
    if (!m || m.source !== 'autopay' || m.stripeObjectType !== 'payment_intent'
      || m.invoiceId !== data.invoice.id || m.orgId !== data.invoice.orgId
      || m.stripeObjectId !== data.attempt.stripePaymentIntentId
      || m.stripePaymentIntentId !== data.attempt.stripePaymentIntentId
      || m.amount !== data.attempt.principalAmount || m.feeAmount !== data.attempt.feeAmount
      || m.currency !== data.attempt.currency || !m.stripeAccountId
      || (m.paymentMethodType !== 'card' && m.paymentMethodType !== 'us_bank_account')) {
      throw new Error('Historical payment binding mismatch');
    }
    return {...data,mapping:m,methodType:m.paymentMethodType};
  },'autopay.loadHistory');
}
type AttemptHistory = Awaited<ReturnType<typeof loadAttemptForReconciliation>>;

// Durable cancellation intent in the existing schedule state_reason field.
// Commit under the invoice lock before Stripe cancellation; consume only after
// verified cancellation and release of every invoice reservation.
const RENOTICE_PENDING = 'control_pending:renotice';

// PostgreSQL default now() retains microseconds; postgres.js Date values retain
// milliseconds. Compare at the decoded precision while holding the invoice lock.
function attemptStateGuard(attempt: typeof invoiceCollectionAttempts.$inferSelect) {
  return and(eq(invoiceCollectionAttempts.id, attempt.id), eq(invoiceCollectionAttempts.state, attempt.state),
    sql`date_trunc('milliseconds', ${invoiceCollectionAttempts.updatedAt}) = ${attempt.updatedAt.toISOString()}::timestamptz`);
}

// Staff messages never carry raw ids: the staff renderer names the invoice by number (P-17).
const LOST_CREATE_MESSAGE = 'Verifying the original Stripe account for a lost payment creation. The reservation is kept until the provider outcome is verified.';
async function quarantineUnknownCreate(attemptId: string): Promise<void> {
  const record = await withSystemDbAccessContext(() => loadAttemptRecord(attemptId));
  try {
    const provenance = await resolveAttemptProvenance(record.attempt, record.invoice);
    const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(record.invoice.partnerId, {
      reconciliationAccountId: provenance.stripeAccountId, reason: 'autopay_recovery',
    }));
    const found = await runOutsideDbContext(() => stripe.paymentIntents.search({
      query: `metadata['attempt_id']:'${attemptId}'`, limit: 2,
    }));
    if (found.has_more || found.data.length > 1) throw new Error('Multiple PaymentIntents match attempt provenance');
    if (found.data.length === 0) {
      await withSystemDbAccessContext(async () => {
        const locked = await lockInvoiceForCollection(db, record.invoice.id);
        const current = await loadAttemptRecord(attemptId);
        if (current.attempt.stripePaymentIntentId || !['reserved', 'created'].includes(current.attempt.state)) return;
        await db.update(invoiceCollectionAttempts).set({ state: 'canceled', failureCode: 'provider_create_not_found', updatedAt: new Date() })
          .where(attemptStateGuard(current.attempt));
        const [schedule] = await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.invoiceId, locked.invoice.id)).limit(1);
        const [enrollment] = await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId, locked.invoice.orgId)).limit(1);
        await finalizeCanceledSchedule(locked.invoice, schedule, enrollment, 'provider_create_not_found');
      }, 'autopay.releaseUnknownCreate');
    } else {
      const pi = found.data[0]!;
      if (pi.metadata.attempt_id !== attemptId || pi.metadata.invoice_id !== record.invoice.id
        || pi.metadata.partner_id !== record.invoice.partnerId || pi.currency.toUpperCase() !== record.attempt.currency
        || pi.amount !== toMinorUnits(record.attempt.principalAmount, record.attempt.currency)
          + toMinorUnits(record.attempt.feeAmount, record.attempt.currency)) throw new Error('Recovered PaymentIntent binding mismatch');
      await assertOriginalOrgProvenance(pi.metadata.org_id, record.invoice.orgId, record.invoice.partnerId);
      await withSystemDbAccessContext(async () => {
        await lockInvoiceForCollection(db, record.invoice.id);
        const current = await loadAttemptRecord(attemptId);
        if (current.attempt.stripePaymentIntentId || !['reserved', 'created'].includes(current.attempt.state)) return;
        const values = { orgId: record.attempt.orgId, invoiceId: record.invoice.id,
          stripeAccountId: provenance.stripeAccountId, stripeObjectType: 'payment_intent' as const,
          stripeObjectId: pi.id, stripePaymentIntentId: pi.id, amount: record.attempt.principalAmount,
          feeAmount: record.attempt.feeAmount, currency: record.attempt.currency, source: 'autopay' as const,
          paymentMethodType: provenance.methodType, status: 'pending' as const };
        const [inserted] = await db.insert(invoiceStripePayments).values(values).onConflictDoNothing().returning();
        const [mapping] = inserted ? [inserted] : await db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripeObjectId, pi.id)).limit(1);
        if (!mapping || Object.entries(values).some(([key, value]) => key !== 'status'
          && mapping[key as keyof typeof mapping] !== value)) throw new Error('Recovered mapping conflict');
        await db.update(invoiceCollectionAttempts).set({ state: 'created', stripePaymentIntentId: pi.id,
          invoiceStripePaymentId: mapping.id, failureCode: null, updatedAt: new Date() }).where(attemptStateGuard(current.attempt));
      }, 'autopay.adoptUnknownCreate');
      // Old unconfirmed creates are canceled; captured/processing money follows normal settlement.
      await resumeCollectionAttempt(attemptId, true);
    }
    return;
  } catch (error) {
    if (isCollectionProgrammingError(error)) throw error;
    console.error('[autopay] Original-account recovery remains quarantined', { invoiceId: record.invoice.id, orgId: record.invoice.orgId, attemptId, error });
    captureException(error, undefined, { attempt_id: attemptId, invoice_id: record.invoice.id, org_id: record.invoice.orgId, autopay_phase: 'quarantine' });
  }
  const quarantined = await withSystemDbAccessContext(async () => {
    const locked = await lockInvoiceForCollection(db, record.invoice.id);
    const current = await loadAttemptRecord(attemptId);
    if (current.attempt.stripePaymentIntentId || !['reserved', 'created'].includes(current.attempt.state)) return false;
    await db.update(invoiceCollectionAttempts).set({ failureCode: 'provider_create_unknown' })
      .where(attemptStateGuard(current.attempt));
    if (current.attempt.scheduleId) {
      const [schedule] = await db.select().from(invoiceAutopaySchedules)
        .where(eq(invoiceAutopaySchedules.id, current.attempt.scheduleId)).limit(1);
      if (!pendingInvoiceControl(schedule?.stateReason ?? null)) await db.update(invoiceAutopaySchedules)
        .set({ stateReason: 'provider_create_unknown' }).where(eq(invoiceAutopaySchedules.id, current.attempt.scheduleId));
    }
    await enqueueOutcomeAttention('autopay.needs_attention', locked.invoice, attemptId, LOST_CREATE_MESSAGE);
    return { orgId: locked.invoice.orgId, partnerId: locked.invoice.partnerId };
  }, 'autopay.quarantine');
  if (quarantined) await notifyPaymentAttention({ ...quarantined, invoiceId: record.invoice.id,
    attemptId, event: 'autopay.needs_attention',
    message: LOST_CREATE_MESSAGE });
}

/** Cancellation errors never prove that money is safe to release. */
async function cancelOrRetrieve(stripe: Stripe, pi: Stripe.PaymentIntent): Promise<Stripe.PaymentIntent> {
  try {
    return await runOutsideDbContext(() => stripe.paymentIntents.cancel(pi.id));
  } catch {
    return runOutsideDbContext(() => stripe.paymentIntents.retrieve(pi.id));
  }
}

async function historicalClient(data: AttemptHistory) {
  return withSystemDbAccessContext(() => getPartnerStripeClient(data.invoice.partnerId, {
    reconciliationAccountId: data.mapping.stripeAccountId,
    archivedCredentialId: data.mapping.revocationCredentialId, invoiceStripePaymentId: data.mapping.id,
    reason: 'autopay_recovery',
  }));
}

async function validateIntent(data: AttemptHistory, pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.id !== data.mapping.stripeObjectId || pi.metadata.attempt_id !== data.attempt.id
    || pi.metadata.invoice_id !== data.invoice.id || pi.metadata.partner_id !== data.invoice.partnerId
    || pi.currency.toUpperCase() !== data.attempt.currency
    || pi.amount !== toMinorUnits(data.attempt.principalAmount, data.attempt.currency)
      + toMinorUnits(data.attempt.feeAmount, data.attempt.currency)) throw new Error('PaymentIntent binding mismatch');
  await assertOriginalOrgProvenance(pi.metadata.org_id, data.invoice.orgId, data.invoice.partnerId);
}

/** Called under the invoice lock after provider cancellation; never guesses that cancellation succeeded. */
async function finalizeCanceledSchedule(invoice: typeof invoices.$inferSelect,
  schedule: typeof invoiceAutopaySchedules.$inferSelect | undefined, enrollment: Enrollment | undefined,
  reason: string | null): Promise<void> {
  if (!schedule || !isControllableSchedule(schedule.state)) return;
  const [reserving] = await db.select({ id: invoiceCollectionAttempts.id }).from(invoiceCollectionAttempts)
    .where(and(eq(invoiceCollectionAttempts.invoiceId, invoice.id),
      inArray(invoiceCollectionAttempts.state, [...RESERVING_COLLECTION_ATTEMPT_STATES]))).limit(1);
  if (reserving) return;
  if (reason === 'action_required_expired' && !pendingInvoiceControl(schedule.stateReason)) {
    await db.update(invoiceAutopaySchedules).set({ state: 'failed', stateReason: reason, nextAttemptAt: null })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    return;
  }
  const pending = pendingInvoiceControl(schedule.stateReason);
  // Finalize only the live schedule; terminal history is preserved above.
  if (pending === 'skip' || pending === 'exclude') {
    await finalizeInvoiceControl(db, invoice, schedule, pending);
    return;
  }
  if (pending === 'stop') {
    await db.update(invoiceAutopaySchedules).set({ state: 'cancelled', stateReason: 'stop', nextAttemptAt: null })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    return;
  }
  const control = pending
    ?? (schedule.mspExcludedAt || invoice.autopayExcluded ? 'exclude'
      : schedule.clientSkippedAt ? 'skip' : enrollment?.status !== 'active' ? 'stop' : null);
  if (control === 'skip' || control === 'exclude') {
    await finalizeInvoiceControl(db, invoice, schedule, control);
    return;
  }
  if (schedule.stateReason === RENOTICE_PENDING && !collectionFenced({ schedule: schedule, invoice: invoice, enrollment })) {
    const method = await getAutopayMethod(db, invoice.orgId);
    if (method?.status === 'active' && method.enrollmentId === enrollment?.id) {
      await renoticeCanceledAttempt(invoice, schedule, method);
      return;
    }
    reason = 'authority_changed';
  }
  await db.update(invoiceAutopaySchedules).set({ state: control === 'stop' ? 'cancelled'
    : reason === 'excluded_contract' ? 'excluded_by_msp' : 'cancelled',
    stateReason: control ?? reason ?? 'provider_canceled', nextAttemptAt: null })
    .where(eq(invoiceAutopaySchedules.id, schedule.id));
}

async function loadClientCapture(attempt: typeof invoiceCollectionAttempts.$inferSelect) {
  const prefix = 'autopay-bankpay:';
  if (!attempt.idempotencyKey.startsWith(prefix) || !attempt.paymentMethodId) return null;
  const setupId = attempt.idempotencyKey.slice(prefix.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupId)) return null;
  const [setup] = await db.select().from(autopaySetupAttempts).where(and(
    eq(autopaySetupAttempts.orgId, attempt.orgId), eq(autopaySetupAttempts.id, setupId),
  )).limit(1);
  // The attempt's method FK and unique key hold consumption; accepted consent is immutable.
  // Same-method replacement can change the method's SetupIntent. Recover with the
  // original setup; only confirmationDecision checks that it is still current.
  const [method] = await db.select().from(orgPaymentMethods)
    .where(eq(orgPaymentMethods.id, attempt.paymentMethodId)).limit(1);
  const parsed = autopayConsentSnapshotSchema.safeParse(setup?.consentSnapshot);
  const bank = parsed.success ? parsed.data.bankPayment : null;
  if (!setup || !bank || !method || bank.invoiceId !== attempt.invoiceId || bank.orgId !== attempt.orgId
    || method.orgId !== attempt.orgId || method.enrollmentId !== setup.enrollmentId
    || method.type !== 'us_bank_account' || !method.accountHolderType
    || !setup.setupIntentId || bank.currency !== attempt.currency
    || toMinorUnits(attempt.principalAmount, attempt.currency) !== toMinorUnits(bank.principal, bank.currency)
    || toMinorUnits(attempt.feeAmount, attempt.currency) !== toMinorUnits(bank.fee, bank.currency)
    || !setup.stripeCustomerId || setup.outcome !== 'activated') return null;
  return { setup, bank, collection: { methodId: method.id, stripePaymentMethodId: method.stripePaymentMethodId,
    setupIntentId: setup.setupIntentId, accountHolderType: method.accountHolderType }, snapshot: parsed.data! };
}

async function confirmationDecision(attemptId: string, pi: Stripe.PaymentIntent) {
  return withSystemDbAccessContext(async () => {
    const data = await loadAttemptRecord(attemptId);
    const locked = await lockInvoiceForCollection(db, data.invoice.id);
    const { attempt } = await loadAttemptRecord(attemptId);
    if (!['created', 'confirming'].includes(attempt.state)) return { action: 'done' as const };
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.orgId, locked.invoice.orgId)).limit(1).for('update');
    // Replacement holds this lock and can preserve generation; read its committed method afterward.
    const method = await getAutopayMethod(db, locked.invoice.orgId);
    // Invoice-wide fence includes unscheduled client attempts.
    const [schedule] = await db.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.invoiceId, locked.invoice.id)).limit(1).for('update');
    const cancel = async (reason: string) => {
      // Only a live schedule has a notice to redo; finalizeCanceledSchedule ignores the rest. A
      // marker left on a terminal schedule (an on-session bank payment's invoice) would cancel
      // every later confirm on that invoice, including the client's re-authorized one (#7896).
      if (reason === 'renotice_required' && schedule && isControllableSchedule(schedule.state)
        && schedule.stateReason !== RENOTICE_PENDING) {
        await db.update(invoiceAutopaySchedules).set({ stateReason: RENOTICE_PENDING })
          .where(eq(invoiceAutopaySchedules.id, schedule.id));
      }
      return { action: 'cancel' as const, reason };
    };
    if (collectionFenced({ schedule: schedule, invoice: locked.invoice, enrollment })) return cancel('collection_fenced');
    if (schedule?.stateReason === RENOTICE_PENDING) return cancel('renotice_required');
    const readiness = await getAutopayStripeReadiness(db, locked.invoice.partnerId);
    if (!enrollment || !method || method.status !== 'active'
      || !method.isAutopayMethod || method.enrollmentId !== enrollment.id
      || enrollment.partnerId !== locked.invoice.partnerId || method.orgId !== locked.invoice.orgId
      || !readiness.ready || readiness.stripeAccountId !== data.mapping?.stripeAccountId
      || enrollment.stripeAccountId !== data.mapping?.stripeAccountId
      || (typeof pi.customer === 'string' ? pi.customer : pi.customer?.id) !== enrollment.stripeCustomerId
      || !await isAutopayEnabledForPartner(db, locked.invoice.partnerId)
      || !['sent', 'partially_paid', 'overdue'].includes(locked.invoice.status)
      || toMinorUnits(locked.invoice.balance, locked.invoice.currencyCode) < toMinorUnits(attempt.principalAmount, attempt.currency)
      || (attempt.scheduleId && (!schedule || schedule.id !== attempt.scheduleId || schedule.state !== 'collecting'
        || schedule.enrollmentId !== enrollment.id || schedule.enrollmentGeneration !== enrollment.generation))) {
      return cancel('authority_changed');
    }
    if (method.id !== attempt.paymentMethodId || method.type !== data.mapping?.paymentMethodType
      || (typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id) !== method.stripePaymentMethodId) {
      return cancel('renotice_required');
    }
    if (attempt.initiatedBy === 'client_on_session') {
      const capture = await loadClientCapture(attempt);
      if (!capture || capture.setup.enrollmentId !== enrollment.id || capture.setup.generation !== enrollment.generation
        || capture.setup.stripeAccountId !== enrollment.stripeAccountId || capture.setup.stripeCustomerId !== enrollment.stripeCustomerId
        || capture.collection.methodId !== method.id || capture.collection.stripePaymentMethodId !== method.stripePaymentMethodId
        || capture.collection.setupIntentId !== method.stripeSetupIntentId) return cancel('authority_changed');
    }
    const [excluded] = await db.select({ id: contracts.id }).from(invoiceLines).innerJoin(contracts,
      and(eq(invoiceLines.sourceContractId, contracts.id), eq(invoiceLines.orgId, contracts.orgId)))
      .where(and(eq(invoiceLines.invoiceId, locked.invoice.id), eq(contracts.autopayExcluded, true))).limit(1);
    if (excluded) return cancel('excluded_contract');
    const settings = await resolveBillingPaymentSettings(db, { partnerId: locked.invoice.partnerId, orgId: locked.invoice.orgId });
    const [org] = await db.select().from(organizations).where(eq(organizations.id, locked.invoice.orgId)).limit(1);
    if (!org || org.partnerId !== locked.invoice.partnerId || org.deletedAt || !['active','trial'].includes(org.status)) return cancel('authority_changed');
    const terms = attempt.scheduleId && schedule ? parseAutopayTerms(schedule.termsSnapshot) : undefined;
    const lawfulQuote = quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
      principal: attempt.principalAmount, currency: attempt.currency, stripeAccountCountry: readiness.accountCountry,
      orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
      cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value, feeAttested: settings.feeAttested });
    const quote = attempt.initiatedBy === 'client_on_session' ? lawfulQuote : await acceptedCollectionFee(db, {
      orgId:locked.invoice.orgId,partnerId:locked.invoice.partnerId,enrollmentId:enrollment.id,generation:enrollment.generation,
      methodId:method.id,methodType:method.type,principal:attempt.principalAmount,currency:attempt.currency,quote:lawfulQuote,
    });
    if (!quote) return cancel('authority_changed');
    if (attempt.scheduleId) {
      // Defense in depth for planning: never charge an invoice above the cap the client
      // accepted, nor above a lower current MSP cap. Unscheduled (on-session) payments
      // carry their own per-invoice authorization and are not autopay.
      const acceptedCap = await acceptedAutopayCap(db, { orgId: locked.invoice.orgId, enrollmentId: enrollment.id,
        generation: enrollment.generation, methodId: method.id });
      const capReason = acceptedCap ? autopayCapReason({ current: settings.autopayCap.value, accepted: acceptedCap,
        total: locked.invoice.total, currency: locked.invoice.currencyCode }) : 'consent_required';
      if (capReason) return cancel(capReason);
    }
    const changed = !terms ? (pi.metadata.authority_generation !== String(enrollment.generation)
      || pi.metadata.authority_customer !== enrollment.stripeCustomerId
      || pi.metadata.authority_method !== method.stripePaymentMethodId
      || pi.metadata.authority_holder !== (method.accountHolderType ?? '')
      || pi.metadata.authority_funding !== (method.cardFunding ?? '')
      // Other-rail fee metadata may be absent on older intents and cannot invalidate this charge.
      || (method.type === 'card' && pi.metadata.authority_card_fee_bps !== String(settings.cardFeeBps.value))
      || (method.type === 'us_bank_account' && pi.metadata.authority_ach_fee !== settings.achFeeAmount.value))
      : terms.methodId !== method.id || terms.methodType !== method.type
        || terms.accountHolderType !== method.accountHolderType || terms.noticeLeadDays !== noticeLeadDays(method)
        || collectionFeePolicyChanged(terms, {cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value}, quote)
        || terms.currency !== attempt.currency
        || toMinorUnits(attempt.principalAmount, attempt.currency) > toMinorUnits(terms.principal, attempt.currency)
        || toMinorUnits(attempt.feeAmount, attempt.currency) > toMinorUnits(terms.feeAmount, attempt.currency)
        || !collectionNoticeAllows(schedule!.noticeSentAt, terms.noticeLeadDays, new Date());
    const currentFee = toMinorUnits(quote.feeAmount, attempt.currency);
    const reservedFee = toMinorUnits(attempt.feeAmount, attempt.currency);
    if (changed || reservedFee > currentFee
      || (terms && reservedFee !== toMinorUnits(clampNoticedFee(quote, attempt.currency, terms.feeAmount), attempt.currency))) {
      return cancel('renotice_required');
    }
    await db.update(invoiceCollectionAttempts).set({ state: 'confirming', updatedAt: new Date() })
      .where(attemptStateGuard(attempt));
    return { action: 'confirm' as const };
  }, 'autopay.beforeConfirm');
}

/** A rejected create has no provider object and therefore no captured funds. */
async function rejectCreate(data: Awaited<ReturnType<typeof loadAttempt>>, error: Stripe.errors.StripeError): Promise<void> {
  const failureClass = classifyCollectionFailure({ methodType: data.method.type, code: error.code ?? null,
    declineCode: error.decline_code ?? null, achReturnCode: null, piStatus: 'requires_payment_method' });
  const invalidMethod = (failureClass === 'hard' || failureClass === 'revoked')
    && (error.type === 'StripeCardError' || error.param === 'payment_method'
      || error.code === 'payment_method_unexpected_state');
  const attention = await withSystemDbAccessContext(async () => {
    const locked = await lockInvoiceForCollection(db, data.invoice.id);
    const { attempt } = await loadAttemptRecord(data.attempt.id);
    if (attempt.stripePaymentIntentId || !['reserved', 'created'].includes(attempt.state)) return null;
    const [schedule] = await db.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.invoiceId, locked.invoice.id)).limit(1).for('update');
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.id, data.enrollment.id)).limit(1);
    await db.update(invoiceCollectionAttempts).set({ state: 'failed', failureClass,
      failureCode: error.code ?? error.type, declineCode: error.decline_code ?? null, updatedAt: new Date() })
      .where(attemptStateGuard(attempt));
    const [first] = await db.select({ createdAt: invoiceCollectionAttempts.createdAt }).from(invoiceCollectionAttempts)
      .where(attempt.scheduleId ? eq(invoiceCollectionAttempts.scheduleId, attempt.scheduleId)
        : eq(invoiceCollectionAttempts.id, attempt.id)).orderBy(asc(invoiceCollectionAttempts.createdAt)).limit(1);
    const mayAdvance = schedule && schedule.id === attempt.scheduleId && schedule.attemptCount === attempt.attemptNo
      && isControllableSchedule(schedule.state) && enrollment?.generation === schedule.enrollmentGeneration
      && !collectionFenced({ schedule: schedule, invoice: locked.invoice, enrollment });
    const next = mayAdvance ? retryAt(first!.createdAt, new Date(), failureClass, attempt.attemptNo) : null;
    if (mayAdvance) await db.update(invoiceAutopaySchedules).set({ state: next ? 'retry_scheduled' : 'failed',
      stateReason: failureClass, nextAttemptAt: next }).where(eq(invoiceAutopaySchedules.id, schedule.id));
    else await finalizeCanceledSchedule(locked.invoice, schedule, enrollment, null);
    if (invalidMethod) await markPaymentMethodUnusable(db, data.method.id, error.code ?? failureClass);
    await enqueueAttemptNotice(db, attempt.id, invalidMethod ? 'update' : 'pay');
    if (next) return null;
    const notice = { partnerId: locked.invoice.partnerId, orgId: locked.invoice.orgId,
      invoiceId: locked.invoice.id, attemptId: attempt.id, event: 'payment.failed_final' as const };
    await enqueueAutopayStaffNotifications(db, { ...notice,
      dedupeKey: `autopay:${attempt.id}:payment.failed_final`,
      message: 'Automatic payment could not be created. The client can pay directly.' });
    return notice;
  }, 'autopay.rejectCreate');
  if (attention) await notifyPaymentAttention(attention);
}

export async function resumeCollectionAttempt(attemptId: string, cancelOnly = false): Promise<void> {
  assertNoHeldDbContextForStripe('resumeCollectionAttempt');
  let record = await withSystemDbAccessContext(() => loadAttemptRecord(attemptId));
  if (!record.attempt.stripePaymentIntentId) {
    if (!['reserved', 'created'].includes(record.attempt.state)) return;
    if (record.attempt.failureCode === 'provider_create_unknown'
      || Date.now() - record.attempt.createdAt.getTime() >= 23 * 3_600_000) {
      await quarantineUnknownCreate(attemptId); return;
    }
    const data = await loadAttempt(attemptId);
    const capture = data.attempt.initiatedBy === 'client_on_session'
      ? await withSystemDbAccessContext(() => loadClientCapture(data.attempt)) : null;
    if (data.attempt.initiatedBy === 'client_on_session' && !capture) throw new Error('Client payment authority missing');
    let provenance:Awaited<ReturnType<typeof resolveAttemptProvenance>>;
    try { provenance=await resolveAttemptProvenance(data.attempt,data.invoice); }
    catch(error) { if(isCollectionProgrammingError(error))throw error; await quarantineUnknownCreate(attemptId);return; }
    const accountId = provenance.stripeAccountId;
    const customerId = provenance.stripeCustomerId;
    const paymentMethodId = capture?.collection.stripePaymentMethodId ?? data.method.stripePaymentMethodId;
    const methodType = capture ? 'us_bank_account' as const : data.method.type;
    const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(data.invoice.partnerId, {
      reconciliationAccountId: accountId, reason: 'autopay_recovery',
    }));
    const { settings, partnerName } = await withSystemDbAccessContext(async () => ({
      settings: await resolveBillingPaymentSettings(db, { partnerId: data.invoice.partnerId, orgId: data.invoice.orgId }),
      partnerName: (await db.select({ name: partners.name }).from(partners).where(eq(partners.id, data.invoice.partnerId)).limit(1))[0]?.name ?? null,
    }));
    const params = paymentIntentCreateParams(data.attempt, customerId,
      paymentMethodId, data.invoice.partnerId, methodType, paymentIntentDescription(data.invoice.invoiceNumber, partnerName));
    // Unscheduled attempts have no notice snapshot. Bind their create-time authority to the PI.
    if (!data.attempt.scheduleId) Object.assign(params.metadata!, {
      authority_generation: String(capture?.setup.generation ?? data.enrollment.generation), authority_customer: customerId,
      authority_method: paymentMethodId, authority_holder: capture?.collection.accountHolderType ?? data.method.accountHolderType ?? '',
      authority_funding: capture ? '' : data.method.cardFunding ?? '',
      authority_card_fee_bps: String(capture?.snapshot.feeTerms.cardFeeBps ?? settings.cardFeeBps.value),
      authority_ach_fee: capture?.snapshot.feeTerms.achFeeAmount ?? settings.achFeeAmount.value,
    });
    let pi: Stripe.PaymentIntent;
    try {
      pi = await runOutsideDbContext(() => stripe.paymentIntents.create(params, { idempotencyKey: data.attempt.idempotencyKey }));
    } catch (error) {
      const provider = error as Stripe.errors.StripeError;
      if (provider && ['StripeInvalidRequestError', 'StripeCardError'].includes(provider.type)
        && !provider.payment_intent && (!provider.statusCode || provider.statusCode < 500)) {
        await rejectCreate(data, provider);
        return;
      }
      throw error;
    }
    await withSystemDbAccessContext(async () => {
      await lockInvoiceForCollection(db, data.invoice.id);
      const current = await loadAttemptRecord(attemptId);
      if (current.attempt.stripePaymentIntentId) {
        if (current.attempt.stripePaymentIntentId !== pi.id) throw new Error('PaymentIntent mapping conflict');
        return;
      }
      if (!['reserved', 'created'].includes(current.attempt.state)) throw new Error('Attempt changed before mapping');
      const values = { orgId: data.attempt.orgId, invoiceId: data.attempt.invoiceId,
        stripeAccountId: accountId, stripeObjectType: 'payment_intent' as const,
        stripeObjectId: pi.id, stripePaymentIntentId: pi.id, amount: data.attempt.principalAmount,
        feeAmount: data.attempt.feeAmount, currency: data.attempt.currency, source: 'autopay' as const,
        paymentMethodType: methodType, status: 'pending' as const };
      const [inserted] = await db.insert(invoiceStripePayments).values(values)
        .onConflictDoNothing({ target: invoiceStripePayments.stripeObjectId }).returning();
      const [mapping] = inserted ? [inserted] : await db.select().from(invoiceStripePayments)
        .where(eq(invoiceStripePayments.stripeObjectId, pi.id)).limit(1);
      if (!mapping || Object.entries(values).some(([key, value]) => key !== 'status'
        && mapping[key as keyof typeof mapping] !== value)) throw new Error('PaymentIntent mapping conflict');
      await db.update(invoiceCollectionAttempts).set({ stripePaymentIntentId: pi.id,
        invoiceStripePaymentId: mapping.id, state: 'created', updatedAt: new Date() }).where(attemptStateGuard(current.attempt));
    }, 'autopay.persistIntent');
    record = await withSystemDbAccessContext(() => loadAttemptRecord(attemptId));
  }
  const data = await loadAttemptForReconciliation(attemptId);
  const { stripe } = await historicalClient(data);
  const pi = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(data.attempt.stripePaymentIntentId!));
  await validateIntent(data, pi);
  if (cancelOnly && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
    const canceled = await cancelOrRetrieve(stripe, pi);
    await applyObservedOutcome(data, stripe, canceled);
    return;
  }
  if (pi.status !== 'requires_confirmation' || !['created', 'confirming'].includes(record.attempt.state)) {
    await applyObservedOutcome(data, stripe, pi); return;
  }
  const decision = await confirmationDecision(attemptId, pi);
  if (decision.action === 'done') return;
  if (decision.action === 'cancel') {
    const canceled = await cancelOrRetrieve(stripe, pi);
    await applyObservedOutcome(data, stripe, canceled, decision.reason);
    return;
  }
  try {
    await runOutsideDbContext(() => stripe.paymentIntents.confirm(pi.id,
      { off_session: data.attempt.initiatedBy !== 'client_on_session' },
      { idempotencyKey: `${data.attempt.idempotencyKey}_confirm` }));
  } catch (error) {
    const provider = error as { payment_intent?: unknown; type?: string };
    if (!provider.payment_intent && !['StripeCardError', 'StripeInvalidRequestError'].includes(provider.type ?? '')) throw error;
    console.warn('[autopay] Confirmation rejected', { attemptId, invoiceId: data.invoice.id, error });
    const observed = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(pi.id));
    await validateIntent(data, observed);
    if (observed.status === 'requires_confirmation') {
      await applyObservedOutcome(data, stripe, await cancelOrRetrieve(stripe, observed), 'authority_changed');
      return;
    }
  }
  await applyAttemptOutcome(data.invoice.partnerId, attemptId);
}
export async function attemptCollection(input: CollectionInput): Promise<CollectionResult> {
  assertNoHeldDbContextForStripe('attemptCollection');
  const revocation = await requestInvoiceSessionRevocation({ invoiceId: input.invoiceId,
    reason: 'autopay_collection', requestedByUserId: null });
  if (revocation.charged || revocation.blocked || revocation.stillPending) {
    return { attemptId: null, outcome: 'deferred', reason: 'checkout_session_unrevoked' };
  }
  const reserved = await reserveCollection(input);
  if (!('attempt' in reserved)) return reserved;
  try { await resumeCollectionAttempt(reserved.attempt.id); }
  catch(error) { reportCollectionError(error,{org_id:reserved.attempt.orgId,invoice_id:input.invoiceId,attempt_id:reserved.attempt.id,autopay_phase:'create_confirm'});throw error; }
  const {attempt}=await withSystemDbAccessContext(()=>loadAttemptRecord(reserved.attempt.id));
  if(attempt.state==='failed'||attempt.state==='canceled'||attempt.state==='requires_action'||attempt.state==='unapplied') {
    return {attemptId:attempt.id,outcome:attempt.state,state:attempt.state,failureClass:attempt.failureClass,
      reason:attempt.failureCode ?? attempt.state};
  }
  return { attemptId: attempt.id, outcome: 'created',state:attempt.state,failureClass:attempt.failureClass };
}

export function outcomeState(status: string, code: string | null) {
  if (status === 'succeeded') return 'succeeded' as const;
  if (status === 'processing') return 'processing' as const;
  if (status === 'canceled') return 'canceled' as const;
  if (status === 'requires_action' || code === 'authentication_required') return 'requires_action' as const;
  if (status === 'requires_confirmation') return 'created' as const;
  return 'failed' as const;
}
export async function readProviderFailure(stripe: Stripe, pi: Stripe.PaymentIntent,
  methodType: 'card' | 'us_bank_account') {
  const charge = methodType === 'us_bank_account' && pi.last_payment_error && pi.latest_charge
    ? typeof pi.latest_charge === 'string'
      ? await runOutsideDbContext(() => stripe.charges.retrieve(pi.latest_charge as string))
      : pi.latest_charge : null;
  const code = pi.last_payment_error?.code ?? charge?.failure_code ?? null;
  const declineCode = pi.last_payment_error?.decline_code ?? charge?.outcome?.reason ?? null;
  const network = (charge?.outcome as {network_decline_code?:string|null}|null)?.network_decline_code;
  const raw = [network, code, declineCode].find(value => typeof value === 'string' && /^R\d{2}$/.test(value));
  // Older Stripe API versions may supply only the documented normalized code.
  const normalized: Record<string,string> = {insufficient_funds:'R01',bank_account_closed:'R02',
    bank_account_invalid_details:'R03',debit_not_authorized:'R07',bank_account_frozen:'R16',bank_account_restricted:'R20'};
  return {code,declineCode,achReturnCode:methodType === 'us_bank_account'
    ? raw ?? normalized[declineCode ?? code ?? ''] ?? null : null};
}
export async function assertOriginalOrgProvenance(originalOrgId: string | undefined,currentOrgId: string,partnerId: string): Promise<void> {
  if (!originalOrgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(originalOrgId)) {
    throw new Error('PaymentIntent organization provenance missing');
  }
  const chain = await resolveMergedOrgIds(originalOrgId,partnerId);
  if (!chain.includes(currentOrgId)) throw new Error('PaymentIntent organization provenance mismatch');
}
export async function applyAttemptOutcome(partnerId: string, attemptId: string): Promise<void> {
  assertNoHeldDbContextForStripe('applyAttemptOutcome');
  const data = await loadAttemptForReconciliation(attemptId);
  if (data.invoice.partnerId !== partnerId) throw new Error('Attempt partner mismatch');
  if (!data.attempt.stripePaymentIntentId || data.attempt.failureCode === 'unapplied_refunded') return;
  const accountId = data.mapping.stripeAccountId;
  const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId, {
    reconciliationAccountId: accountId, archivedCredentialId: data.mapping?.revocationCredentialId,
    invoiceStripePaymentId: data.mapping?.id, reason: 'autopay_outcome',
  }));
  const pi = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(data.attempt.stripePaymentIntentId!));
  await applyObservedOutcome(data, stripe, pi);
}

/** Matches the confirm_payment link TTL minted with the 'confirm' notice. */
const ACTION_REQUIRED_TTL_MS = 14 * 86_400_000;
const ACTION_EXPIRY_PI_STATUSES: readonly string[] = ['requires_action', 'requires_payment_method'];
async function applyObservedOutcome(data: AttemptHistory, stripe: Stripe, observed: Stripe.PaymentIntent,
  cancellationReason: string | null = null): Promise<void> {
  if (data.attempt.failureCode === 'unapplied_refunded') return;
  const partnerId = data.invoice.partnerId;
  const attemptId = data.attempt.id;
  let pi = observed;
  await validateIntent(data, pi);
  // Off-session 3DS arrives as requires_payment_method + authentication_required,
  // never requires_action. updatedAt is the moment the 402 was observed: same-class
  // reconcile passes below write it back unchanged, so the 14-day clock never restarts.
  if (data.attempt.state === 'requires_action' && ACTION_EXPIRY_PI_STATUSES.includes(pi.status)
    && Date.now() - data.attempt.updatedAt.getTime() >= ACTION_REQUIRED_TTL_MS) {
    pi = await cancelOrRetrieve(stripe, pi);
    await validateIntent(data, pi);
    if (pi.status !== 'canceled' && pi.status !== 'succeeded') return;
    cancellationReason = 'action_required_expired';
  }
  const failure = await readProviderFailure(stripe, pi, data.methodType);
  let state = outcomeState(pi.status, failure.code);
  if (state === 'created') return;
  // Persist the first observed failure while still reserving funds. A crash or
  // cancel timeout must neither release money nor restart the NSF retry clock.
  if (state === 'failed') {
    const failureClass = classifyCollectionFailure({ ...failure, methodType: data.methodType, piStatus: pi.status });
    await withSystemDbAccessContext(async () => {
      await lockInvoiceForCollection(db, data.invoice.id);
      const { attempt } = await loadAttemptRecord(attemptId);
      if (['succeeded', 'unapplied'].includes(attempt.state) || attempt.failureClass) return;
      await db.update(invoiceCollectionAttempts).set({ failureClass,
        failureCode: failure.achReturnCode ?? failure.code, declineCode: failure.declineCode, updatedAt: new Date() })
        .where(attemptStateGuard(attempt));
    }, 'autopay.observeFailure');
    if (pi.status !== 'requires_payment_method') return; // Unknown provider state: retain the reservation.
    pi = await cancelOrRetrieve(stripe, pi);
    await validateIntent(data, pi);
    if (!['canceled', 'succeeded', 'processing'].includes(pi.status)) return;
    state = outcomeState(pi.status, null);
    // Only verified cancellation can release funds; concurrent settlement still wins below.
  }
  if (state === 'succeeded') await settlePaymentIntent(partnerId, pi.id);
  const event = await withSystemDbAccessContext(async () => {
    const locked = await lockInvoiceForCollection(db,data.invoice.id);
    await assertOriginalOrgProvenance(pi.metadata.org_id,locked.invoice.orgId,partnerId);
    const [attempt] = await db.select().from(invoiceCollectionAttempts)
      .where(eq(invoiceCollectionAttempts.id, attemptId)).limit(1).for('update');
    if (!attempt) throw new Error('Attempt disappeared');
    if (attempt.failureCode === 'unapplied_refunded') return null;
    if (['succeeded', 'unapplied'].includes(attempt.state) && state !== 'succeeded') return null;
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.id, attempt.invoiceStripePaymentId!)).limit(1);
    const [schedule] = await db.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.invoiceId, locked.invoice.id)).limit(1).for('update');
    const [method] = attempt.paymentMethodId ? await db.select().from(orgPaymentMethods)
      .where(and(eq(orgPaymentMethods.id,attempt.paymentMethodId),eq(orgPaymentMethods.orgId,locked.invoice.orgId))).limit(1) : [];
    const [enrollment] = method ? await db.select().from(orgAutopayEnrollments)
      .where(and(eq(orgAutopayEnrollments.id,method.enrollmentId),eq(orgAutopayEnrollments.orgId,locked.invoice.orgId))).limit(1) : [];
    const mayAdvance = !collectionFenced({ schedule: schedule, invoice: locked.invoice, enrollment }) && !!schedule?.enrollmentId && !!enrollment && !!method
      && schedule.id === attempt.scheduleId && schedule.enrollmentId === enrollment.id && schedule.attemptCount === attempt.attemptNo
      && schedule.enrollmentGeneration === enrollment.generation && enrollment.status === 'active'
      && ['collecting','retry_scheduled','action_required'].includes(schedule.state);
    if (state !== 'succeeded' && state !== 'canceled' && attempt.updatedAt.getTime() !== data.attempt.updatedAt.getTime()) return null;
    if (state === 'succeeded') {
      if (!mapping) throw new Error('Captured attempt has no mapping');
      const reversed = ['refunded','partially_refunded','disputed','partially_disputed'].includes(mapping.status);
      const applied = !!mapping.invoicePaymentId || (reversed && mapping.paymentReceivedAt !== null);
      await db.update(invoiceCollectionAttempts).set({ state: applied ? 'succeeded' : 'unapplied', updatedAt: new Date() })
        .where(attemptStateGuard(attempt));
      if (schedule) await db.update(invoiceAutopaySchedules).set({ state: applied ? 'succeeded' : 'failed',
        stateReason: applied ? (reversed ? 'payment_reversed' : null) : 'payment_unapplied', nextAttemptAt: null,
      }).where(eq(invoiceAutopaySchedules.id, schedule.id));
      if (applied && !reversed) await enqueueAttemptNotice(db, attemptId, 'receipt');
      if (!applied) await enqueueOutcomeAttention('payment.unapplied', locked.invoice, attemptId);
      return applied ? null : {event:'payment.unapplied' as const,orgId:locked.invoice.orgId};
    }
    // A PaymentIntent verified as canceled can never capture. Close its mapping so it
    // does not read as an open payment (P-20); a PI mapping stays capturable by settlement.
    if (pi.status === 'canceled' && mapping?.status === 'pending' && !mapping.invoicePaymentId) {
      await db.update(invoiceStripePayments).set({ status: 'failed', lastEventAt: new Date(), updatedAt: new Date() })
        .where(and(eq(invoiceStripePayments.id, mapping.id), eq(invoiceStripePayments.status, 'pending')));
    }
    // W1 clears authority on merged terminal history. Never restore processing/action/retry
    // states (their CHECK constraints require authority), nor mutate a survivor's method.
    if (!method || !enrollment) {
      if (state === 'canceled') {
        await db.update(invoiceCollectionAttempts).set({ state: 'canceled' }).where(attemptStateGuard(attempt));
        await finalizeCanceledSchedule(locked.invoice, schedule, enrollment, cancellationReason);
      }
      return null;
    }
    if (state === 'processing') {
      await db.update(invoiceCollectionAttempts).set({ state: 'processing', updatedAt: attempt.failureClass ? attempt.updatedAt : new Date() })
        .where(attemptStateGuard(attempt));
      return null;
    }
    if (state === 'canceled' && attempt.state === 'canceled') {
      if (pendingInvoiceControl(schedule?.stateReason ?? null) || schedule?.stateReason === RENOTICE_PENDING) {
        await finalizeCanceledSchedule(locked.invoice, schedule, enrollment, cancellationReason);
      }
      return null;
    }
    if (state === 'canceled' && (!attempt.failureClass || attempt.failureClass === 'auth_required' || cancellationReason
      || pendingInvoiceControl(schedule?.stateReason ?? null) || schedule?.stateReason === RENOTICE_PENDING
      || collectionFenced({ schedule: schedule, invoice: locked.invoice, enrollment }))) {
      await db.update(invoiceCollectionAttempts).set({ state: 'canceled', updatedAt: new Date() })
        .where(attemptStateGuard(attempt));
      await finalizeCanceledSchedule(locked.invoice, schedule, enrollment, cancellationReason);
      if (cancellationReason === 'action_required_expired') {
        await enqueueAttemptNotice(db, attemptId, 'expired');
        await enqueueAutopayStaffNotifications(db, { partnerId, orgId: locked.invoice.orgId,
          invoiceId: locked.invoice.id, event: 'autopay.needs_attention',
          dedupeKey: `autopay:${attemptId}:action_required_expired`,
          message: 'Payment confirmation expired. The payment was canceled and the client can pay directly.' });
      }
      return null;
    }
    const failureClass = (state === 'canceled' ? attempt.failureClass : null) ?? classifyCollectionFailure({ methodType: data.methodType,
      code: failure.code, declineCode: failure.declineCode,
      achReturnCode: failure.achReturnCode, piStatus: pi.status });
    const authRequired = failureClass === 'auth_required';
    const targetState = authRequired ? 'requires_action' as const : 'failed' as const;
    const sameFailure = attempt.state === targetState && attempt.failureClass === failureClass;
    if (sameFailure && attempt.scheduleId && schedule && schedule.attemptCount !== attempt.attemptNo) return null;
    const failureAt = attempt.failureClass === failureClass ? attempt.updatedAt : new Date();
    await db.update(invoiceCollectionAttempts).set({ state: targetState,
      failureCode: (attempt.failureClass === failureClass ? attempt.failureCode : null) ?? failure.achReturnCode ?? failure.code,
      declineCode: (attempt.failureClass === failureClass ? attempt.declineCode : null) ?? failure.declineCode, failureClass, updatedAt: failureAt,
    }).where(attemptStateGuard(attempt));
    const [first] = await db.select({ createdAt: invoiceCollectionAttempts.createdAt }).from(invoiceCollectionAttempts)
      .where(attempt.scheduleId ? eq(invoiceCollectionAttempts.scheduleId, attempt.scheduleId)
        : eq(invoiceCollectionAttempts.id, attempt.id)).orderBy(asc(invoiceCollectionAttempts.createdAt)).limit(1);
    const next = mayAdvance && schedule ? sameFailure && schedule.state === 'retry_scheduled' && schedule.attemptCount === attempt.attemptNo
      ? schedule.nextAttemptAt : retryAt(first!.createdAt, failureAt, failureClass, attempt.attemptNo) : null;
    if (mayAdvance) await db.update(invoiceAutopaySchedules).set({
      state: authRequired ? 'action_required' : next ? 'retry_scheduled' : 'failed',
      stateReason: failureClass, nextAttemptAt: next,
    }).where(eq(invoiceAutopaySchedules.id, schedule!.id));
    if (failureClass === 'hard' || failureClass === 'revoked') {
      await markPaymentMethodUnusable(db, method.id, pi.last_payment_error?.code ?? failureClass);
    }
    await enqueueAttemptNotice(db, attemptId, authRequired ? 'confirm'
      : failureClass === 'hard' || failureClass === 'revoked' ? 'update' : 'pay');
    if (authRequired || !next) await enqueueOutcomeAttention(authRequired ? 'autopay.needs_attention' : 'payment.failed_final', locked.invoice, attemptId);
    return authRequired ? {event:'autopay.needs_attention' as const,orgId:locked.invoice.orgId}
      : next ? null : {event:'payment.failed_final' as const,orgId:locked.invoice.orgId};
  }, 'autopay.applyOutcome');
  if (event) await notifyPaymentAttention({partnerId,orgId:event.orgId,
    invoiceId:data.invoice.id,attemptId,event:event.event});
}

async function renoticeCanceledAttempt(invoice: typeof invoices.$inferSelect,
  schedule: typeof invoiceAutopaySchedules.$inferSelect, method: Method): Promise<void> {
  const terms = parseAutopayTerms(schedule.termsSnapshot);
  const settings = await resolveBillingPaymentSettings(db, { partnerId: invoice.partnerId, orgId: invoice.orgId });
  const readiness = await getAutopayStripeReadiness(db, invoice.partnerId);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
  if (!org || !terms || !invoice.issueDate || !invoice.dueDate) throw new Error('Re-notice authority missing');
  const principal = fromMinorUnits(Math.min(toMinorUnits(invoice.balance, invoice.currencyCode),
    toMinorUnits(terms.principal, invoice.currencyCode)), invoice.currencyCode);
  const lawfulQuote = quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
    principal, currency: invoice.currencyCode, stripeAccountCountry: readiness.accountCountry,
    orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
    cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value, feeAttested: settings.feeAttested });
  const quote = await acceptedCollectionFee(db, {orgId:invoice.orgId,partnerId:invoice.partnerId,
    enrollmentId:schedule.enrollmentId!,generation:schedule.enrollmentGeneration,methodId:method.id,methodType:method.type,
    principal,currency:invoice.currencyCode,quote:lawfulQuote});
  if (!quote) {
    await db.update(invoiceAutopaySchedules).set({state:'cancelled',stateReason:'authority_changed',nextAttemptAt:null})
      .where(eq(invoiceAutopaySchedules.id,schedule.id));
    return;
  }
  const collectOn = computeCollectOn({ issueDate: invoice.issueDate, dueDate: invoice.dueDate,
    offsetDays: terms.offsetDays, rule: terms.rule, noticeDate: new Date().toISOString().slice(0, 10), leadDays: noticeLeadDays(method) });
  await db.update(invoiceAutopaySchedules).set({ state: 'awaiting_notice', stateReason: 'renotice_required',
    nextAttemptAt: null, noticeSentAt: null, noticeOutboxId: null, collectOn,
    termsSnapshot: { ...terms, methodId: method.id, methodType: method.type,
      last4: method.cardLast4 ?? method.bankLast4 ?? '',
      methodLabel: `${method.cardBrand ?? method.bankName ?? 'Payment method'} ••${method.cardLast4 ?? method.bankLast4 ?? ''}`,
      accountHolderType: method.accountHolderType, noticeLeadDays: noticeLeadDays(method), principal,
      feeAmount: quote.feeAmount, feeKind: quote.kind, cardFeeBps: settings.cardFeeBps.value,
      achFeeAmount: settings.achFeeAmount.value, chargeDate: collectOn, noticeSeq: terms.noticeSeq + 1 } })
    .where(eq(invoiceAutopaySchedules.id, schedule.id));
  await enqueueAutopayNotice(db, schedule.id);
}

export async function runAutopayCollection(now = new Date()): Promise<{ attempted: number; deferred: number }> {
  assertNoHeldDbContextForStripe('runAutopayCollection');
  await closeSettledAutopaySchedules();
  let attempted = 0;
  let deferred = 0;
  let cursor: string | undefined;
  const errors:unknown[]=[];
  let total=0;
  for (;;) {
    const due = await withSystemDbAccessContext(() => db.select({id:invoiceAutopaySchedules.id,
      invoiceId:invoiceAutopaySchedules.invoiceId,orgId:invoiceAutopaySchedules.orgId}).from(invoiceAutopaySchedules).where(and(
      inArray(invoiceAutopaySchedules.state,['scheduled','retry_scheduled']),
      lte(invoiceAutopaySchedules.collectOn,now.toISOString().slice(0,10)),
      or(isNull(invoiceAutopaySchedules.nextAttemptAt),lte(invoiceAutopaySchedules.nextAttemptAt,now)),
      cursor ? gt(invoiceAutopaySchedules.id,cursor) : undefined,
    )).orderBy(asc(invoiceAutopaySchedules.id)).limit(200));
    if (!due.length) break;
    for (const row of due) {
      total++;
      try {
        const result=await attemptCollection({invoiceId:row.invoiceId,scheduleId:row.id,initiatedBy:'scheduler'});
        if(result.attemptId)attempted++;else {
          deferred++;
          console.info('[autopay] Collection not started',{orgId:row.orgId,invoiceId:row.invoiceId,scheduleId:row.id,...result});
          await withSystemDbAccessContext(async()=>{
            const { invoice } = await lockInvoiceForCollection(db,row.invoiceId);
            // A hard decline, detach or failed verification left the org with no usable
            // method (getAutopayMethod also returns pending_verification, which keeps
            // deferring). Deferring forever would leave this due invoice uncharged, the
            // client unaware and reminders suppressed: fail it and tell the client once.
            // A replacement method made before this run is admitted above and re-noticed.
            if (result.outcome==='deferred' && result.reason==='method_not_usable' && !await getAutopayMethod(db,invoice.orgId)) {
              const [failed]=await db.update(invoiceAutopaySchedules).set({state:'failed',stateReason:'method_not_usable',nextAttemptAt:null})
                .where(and(eq(invoiceAutopaySchedules.id,row.id),inArray(invoiceAutopaySchedules.state,['scheduled','retry_scheduled'])))
                .returning({id:invoiceAutopaySchedules.id});
              if (failed) await enqueueMethodUnusableNotice(db,row.id);
              return;
            }
            await db.update(invoiceAutopaySchedules).set(result.outcome==='refused'
              ? {state:'failed',stateReason:result.reason,nextAttemptAt:null}
              : {stateReason:result.reason,nextAttemptAt:new Date(now.getTime()+(['charging_disabled','stripe_unavailable','method_not_usable'].includes(result.reason ?? '') ? 86_400_000 : 3_600_000))})
              .where(and(eq(invoiceAutopaySchedules.id,row.id),inArray(invoiceAutopaySchedules.state,['scheduled','retry_scheduled'])));
            if (result.reason === 'charging_disabled') await enqueueAutopayStaffNotifications(db, {
              orgId: invoice.orgId, partnerId: invoice.partnerId, partnerOnly: true,
              event: 'autopay.needs_attention',
              dedupeKey: `autopay:charging_disabled:${invoice.partnerId}:${now.toISOString().slice(0,10)}`,
              message: 'Automatic payments are disabled. Due invoices will be checked again on the next daily run.',
            });
          },'autopay.collectionDeferred');
        }
      } catch(error) {
        deferred++; errors.push(error);
        reportCollectionError(error,{org_id:row.orgId,invoice_id:row.invoiceId,schedule_id:row.id,autopay_phase:'collection'});
        if(isCollectionProgrammingError(error))throw error;
      }
    }
    cursor=due[due.length-1]!.id;
  }
  if(total>0 && errors.length===total)throw new AggregateError(errors,'Every automatic collection failed');
  return { attempted, deferred };
}

async function enqueueOutcomeAttention(event: 'payment.unapplied'|'payment.failed_final'|'autopay.needs_attention', invoice: typeof invoices.$inferSelect, attemptId: string, message?:string) {
  await enqueueAutopayStaffNotifications(db, {orgId:invoice.orgId,partnerId:invoice.partnerId,invoiceId:invoice.id,event,
    dedupeKey:`autopay:${attemptId}:${event}`,message:message ?? (event === 'payment.unapplied' ? 'Captured money could not be applied; review the Stripe payment.' : event === 'payment.failed_final' ? 'Automatic payment stopped retrying; the client can pay directly.' : 'Payment requires attention.')});
}
