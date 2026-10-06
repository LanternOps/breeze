import { autopayTermsSnapshotSchema, formatPaymentMethod, parseAutopayTerms, type AutopaySkipNotNeededReason, type AutopaySkipView, type AutopaySkipViewStatus } from '@breeze/shared';
import { getAutopayMethod } from './paymentMethods';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
import { and, eq, inArray } from 'drizzle-orm';
import { ACTIVE_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { invoices, invoiceAutopaySchedules, invoiceCollectionAttempts, billingNoticeOutbox,
  orgAutopayEnrollments, invoiceLines, contracts, partners } from '../../db/schema';
import { InvoiceServiceError, type InvoiceActor } from '../invoiceTypes';
import { requireInvoiceAccess } from '../invoiceService';
import { assertNoActiveCollection } from './reservation';
import { resolveBillingLinkToken } from './linkTokens';
import { buildPublicInvoiceUrl, peekInvoiceLink } from '../invoiceLinkToken';
import { loadAutopayBranding } from './customerBranding';
import { planAutopayForInvoice, noticeLeadDays } from './scheduler';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
import { isAutopayEnabledForPartner } from './autopayGate';
import { collectionFenced, hasUnstoppableCollection, isControllableSchedule, pendingInvoiceControl, requestInvoiceControl, type InvoiceControlResult } from './collectionControl';
import type { Tx } from './types';
import { coveredByAcceptedCap } from './authorizedCap';

export async function assertControllable(tx: Tx, invoiceId: string): Promise<void> {
  await assertNoActiveCollection(tx, invoiceId);
}

export async function renoticeSchedule(tx: Tx, invoiceId: string): Promise<void> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1).for('update');
  if (!invoice || !schedule?.enrollmentId || schedule.state !== 'scheduled'
    || pendingInvoiceControl(schedule.stateReason)) return;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
  if (collectionFenced({ schedule, invoice, enrollment }) || !enrollment || enrollment.orgId !== invoice.orgId || enrollment.status !== 'active'
    || enrollment.generation !== schedule.enrollmentGeneration) return;
  await planAutopayForInvoice(tx, invoiceId, true);
}

async function skipAuthority(tx: Tx, token: string, lock: boolean) {
  const unavailable = () => new InvoiceServiceError('Link unavailable', 404, 'INVOICE_NOT_FOUND');
  const link = await resolveBillingLinkToken(tx, token, 'skip_invoice');
  if (!link?.invoiceId || !link.enrollmentId) throw unavailable();
  const query = tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId), eq(invoices.orgId, link.orgId))).limit(1);
  const [invoice] = await (lock ? query.for('update') : query);
  if (!invoice) throw unavailable();
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, link.enrollmentId)).limit(1);
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.orgId, link.orgId))).limit(1);
  if (!enrollment || enrollment.orgId !== invoice.orgId || enrollment.status !== 'active'
    || enrollment.generation !== link.generation || !schedule?.enrollmentId
    || schedule.enrollmentId !== enrollment.id || schedule.enrollmentGeneration !== link.generation) throw unavailable();
  return { invoice, schedule };
}

/**
 * The skip page's view: it names the invoice, amount, charge date, method and MSP,
 * and says what the page may offer (status). Only 'ready' offers "Skip this
 * payment". A link that no longer controls the schedule (stopped, paused,
 * re-enrolled) still describes the invoice so the client is never left at
 * "unavailable"; only an unknown link is refused. Read-only (no link is minted).
 */
export async function getSkipInvoiceView(tx: Tx, token: string): Promise<AutopaySkipView> {
  const link = await resolveBillingLinkToken(tx, token, 'skip_invoice');
  if (!link?.invoiceId) throw new InvoiceServiceError('Link unavailable', 404, 'INVOICE_NOT_FOUND');
  const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId), eq(invoices.orgId, link.orgId))).limit(1);
  if (!invoice || invoice.orgId !== link.orgId) throw new InvoiceServiceError('Link unavailable', 404, 'INVOICE_NOT_FOUND');
  const authority = await skipAuthority(tx, token, false).then(() => true, () => false);
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.orgId, invoice.orgId))).limit(1);
  const parsed = schedule ? autopayTermsSnapshotSchema.safeParse(schedule.termsSnapshot) : null;
  const terms = parsed?.success && parsed.data.kind === 'terms' ? parsed.data : null;
  const method = terms ? await getAutopayMethod(tx, invoice.orgId) : null;
  const methodLabel = !terms ? null : method && method.id === terms.methodId
    ? formatPaymentMethod(method)
    : formatPaymentMethod({ type: terms.methodType, cardLast4: terms.last4, bankLast4: terms.last4 });
  const control = pendingInvoiceControl(schedule?.stateReason ?? null);
  // processing: a payment is already with Stripe and the skip would be refused.
  const processing = await hasUnstoppableCollection(tx, invoice.id);
  const live = invoice.status === 'void' ? null : peekInvoiceLink(invoice);
  const status = skipViewStatus(invoice, schedule ?? null, control, processing, authority);
  const [enrollment] = link.enrollmentId ? await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, link.enrollmentId)).limit(1) : [];
  return {
    ...await loadAutopayBranding(tx, { orgId: invoice.orgId, partnerId: invoice.partnerId }),
    status, reason: status === 'not_needed' ? notNeededReason(invoice, schedule ?? null, control, enrollment ?? null, link.generation) : null,
    onHold: !await isAutopayEnabledForPartner(tx, invoice.partnerId),
    state: schedule?.state ?? 'not_needed', collectOn: schedule?.collectOn ?? null, control, processing,
    invoiceNumber: invoice.invoiceNumber, invoiceStatus: invoice.status, dueDate: invoice.dueDate,
    amount: terms?.principal ?? invoice.balance, balance: invoice.balance, fee: terms?.feeAmount ?? null, currency: invoice.currencyCode,
    methodLabel, methodType: terms?.methodType ?? null, invoiceUrl: live ? buildPublicInvoiceUrl(live.token) : null,
  };
}
/** D-22: a stale skip link (paid, closed or void invoice, one not scheduled for
 * automatic payment, or one whose enrollment no longer backs it) reports that
 * skipping is no longer needed instead of offering it. 'processing' uses the same
 * predicate as the skip POST's 409 details.reason 'payment_processing', and wins
 * over a pending control: that money moves regardless. */
function skipViewStatus(invoice: typeof invoices.$inferSelect, schedule: typeof invoiceAutopaySchedules.$inferSelect | null,
  control: ReturnType<typeof pendingInvoiceControl>, processing: boolean, authority: boolean): AutopaySkipViewStatus {
  // Paid means the invoice is paid (V-1, V-2): a succeeded schedule on an invoice that is
  // open again was refunded or returned, and the client needs to know it is owed.
  if (invoice.status === 'paid') return 'paid';
  if (processing) return 'processing';
  // R4: nothing to pay or skip on a voided, closed or settled invoice, whatever the schedule remembers.
  if (!OPEN_INVOICE.includes(invoice.status) || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0) return 'not_needed';
  if (schedule?.state === 'succeeded') return 'reversed';
  if (schedule?.state === 'skipped_by_client') return 'skipped';
  if (!schedule || !authority || !OPEN_INVOICE.includes(invoice.status)
    || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0
    || invoice.autopayExcluded || !schedule.eligible || !isControllableSchedule(schedule.state)
    || control === 'exclude' || control === 'stop') return 'not_needed';
  if (control === 'skip') return 'pending';
  return schedule.state === 'action_required' ? 'action_required' : 'ready';
}

const OPEN_INVOICE = ['sent', 'partially_paid', 'overdue'];
/** V-11: why a skip link has nothing to skip, most specific first. */
function notNeededReason(invoice: typeof invoices.$inferSelect, schedule: typeof invoiceAutopaySchedules.$inferSelect | null,
  control: ReturnType<typeof pendingInvoiceControl>, enrollment: typeof orgAutopayEnrollments.$inferSelect | null,
  generation: number | null): AutopaySkipNotNeededReason {
  if (invoice.status === 'void') return 'void';
  if (!OPEN_INVOICE.includes(invoice.status) || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0) return 'nothing_due';
  if (invoice.autopayExcluded || control === 'exclude' || schedule?.state === 'excluded_by_msp') return 'excluded';
  if (schedule?.state === 'failed') return 'failed';
  if (enrollment?.status === 'paused') return 'paused';
  if (control === 'stop' || !enrollment || enrollment.status !== 'active') return 'stopped';
  if (enrollment.generation !== generation || (schedule && (schedule.enrollmentId !== enrollment.id
    || schedule.enrollmentGeneration !== generation))) return 'replaced';
  // R2: only a stop turns automatic payments off; any other cancellation ended this one payment.
  if (schedule?.state === 'cancelled') return schedule.stateReason === 'stop' ? 'stopped' : 'cancelled';
  if (schedule && !schedule.eligible) return 'not_included';
  return 'not_scheduled';
}

export async function skipInvoice(tx: Tx, token: string): Promise<InvoiceControlResult> {
  const { invoice } = await skipAuthority(tx, token, true);
  // Skip tokens are intentionally reusable: the locked durable marker makes replay idempotent.
  return requestInvoiceControl(tx, { invoiceId: invoice.id, kind: 'skip' });
}

export async function setInvoiceAutopayExcluded(tx: Tx, invoiceId: string, excluded: boolean,
  actor: InvoiceActor): Promise<InvoiceControlResult | { status: 'included' }> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  requireInvoiceAccess(actor, invoice);
  if (excluded) return requestInvoiceControl(tx, { invoiceId, kind: 'exclude', actor });
  await assertControllable(tx, invoiceId);
  if (['void', 'paid'].includes(invoice.status)) throw new InvoiceServiceError('Invoice is closed', 409, 'INVALID_STATE');
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1).for('update');
  if (pendingInvoiceControl(schedule?.stateReason ?? null)) {
    throw new InvoiceServiceError('A payment control is pending', 409, 'COLLECTION_IN_PROGRESS');
  }
  await tx.update(invoices).set({ autopayExcluded: false, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  const issuanceExcluded = schedule?.state === 'not_needed' && schedule.ineligibleReason === 'excluded_invoice';
  if (!schedule?.enrollmentId || (schedule.state !== 'excluded_by_msp' && !issuanceExcluded)
    || schedule.clientSkippedAt) return { status: 'included' };
  if (!schedule.eligible && schedule.ineligibleReason !== 'excluded_invoice') return { status: 'included' };
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
  if (!enrollment || enrollment.orgId !== invoice.orgId || enrollment.status !== 'active'
    || enrollment.generation !== schedule.enrollmentGeneration) return { status: 'included' };
  const [excludedContract] = await tx.select({ id: contracts.id }).from(invoiceLines).innerJoin(contracts,
    and(eq(invoiceLines.sourceContractId, contracts.id), eq(invoiceLines.orgId, contracts.orgId)))
    .where(and(eq(invoiceLines.invoiceId, invoiceId), eq(contracts.autopayExcluded, true))).limit(1);
  if (excludedContract) return { status: 'included' };
  await tx.update(invoiceAutopaySchedules).set({ eligible: true, ineligibleReason: null,
    state: 'scheduled', stateReason: null, mspExcludedBy: null, mspExcludedAt: null })
    .where(eq(invoiceAutopaySchedules.id, schedule.id));
  await renoticeSchedule(tx, invoiceId);
  return { status: 'included' };
}

import type { InvoiceAutopayView } from '@breeze/shared';
export type { InvoiceAutopayView } from '@breeze/shared';

/** Only call after authorizing the invoice. Never project provider identifiers or tokens. */
export async function getInvoiceAutopayView(tx: Tx, invoice: typeof invoices.$inferSelect): Promise<InvoiceAutopayView | null> {
  const enabled = await isAutopayEnabledForPartner(tx, invoice.partnerId);
  const attempts = await tx.select({ state: invoiceCollectionAttempts.state }).from(invoiceCollectionAttempts)
    .where(and(eq(invoiceCollectionAttempts.invoiceId, invoice.id), eq(invoiceCollectionAttempts.orgId, invoice.orgId),
      inArray(invoiceCollectionAttempts.state, [...ACTIVE_COLLECTION_ATTEMPT_STATES, 'requires_action', 'unapplied'])));
  const processing = attempts.some(a => (ACTIVE_COLLECTION_ATTEMPT_STATES as readonly string[]).includes(a.state));
  const unapplied = attempts.some(a => a.state === 'unapplied');
  const actionRequired = attempts.some(a => a.state === 'requires_action');
  if (!enabled && !processing && !unapplied && !actionRequired) return null;
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoice.id)).limit(1);
  const pending = pendingInvoiceControl(schedule?.stateReason ?? null)
    ?? (invoice.autopayExcluded && (processing || actionRequired) ? 'exclude' : null);
  let canChargeNow = false;
  if (enabled && schedule?.eligible && schedule.enrollmentId && ['scheduled', 'retry_scheduled'].includes(schedule.state)
    && ['sent', 'partially_paid', 'overdue'].includes(invoice.status) && toMinorUnits(invoice.balance, invoice.currencyCode) > 0
    && !processing && !actionRequired && !unapplied && !pending && schedule.noticeOutboxId && schedule.noticeSentAt
    && !(schedule.state === 'retry_scheduled' && schedule.nextAttemptAt && schedule.nextAttemptAt > new Date())) {
    const [enrollment] = await tx.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
    if (enrollment && enrollment.orgId === invoice.orgId && enrollment.generation === schedule.enrollmentGeneration
      && !collectionFenced({ schedule: schedule, invoice: invoice, enrollment })) {
      const method = await getAutopayMethod(tx, invoice.orgId);
      const ready = await getAutopayStripeReadiness(tx, invoice.partnerId);
      const terms = parseAutopayTerms(schedule.termsSnapshot);
      canChargeNow = !!method && method.status === 'active' && method.isAutopayMethod
        && method.orgId === invoice.orgId && method.enrollmentId === enrollment.id
        && ready.ready && ready.stripeAccountId === enrollment.stripeAccountId
        && (method.type !== 'us_bank_account' || (invoice.currencyCode === 'USD' && !!method.accountHolderType))
        && terms?.methodId === method.id && terms.methodType === method.type
        && terms.accountHolderType === method.accountHolderType && terms.noticeLeadDays === noticeLeadDays(method)
        && Date.now() >= schedule.noticeSentAt.getTime() + terms.noticeLeadDays * 86_400_000;
    }
  }
  // FP-17 (P-15): why a disabled Charge now is disabled, in the refusal vocabulary staff already read.
  let chargeBlockedReason: string | null = null;
  if (!canChargeNow) {
    // A not_needed schedule holds the issuance placeholder: read terms without throwing (2a-4).
    const snapshot = schedule ? autopayTermsSnapshotSchema.safeParse(schedule.termsSnapshot) : null;
    const lead = snapshot?.success && snapshot.data.kind === 'terms' ? snapshot.data.noticeLeadDays : null;
    chargeBlockedReason = processing || actionRequired || unapplied ? 'collection_in_progress'
      : !['sent', 'partially_paid', 'overdue'].includes(invoice.status) ? 'not_payable'
      : toMinorUnits(invoice.balance, invoice.currencyCode) <= 0 ? 'nothing_to_pay'
      : !schedule || !schedule.eligible || !['scheduled', 'retry_scheduled'].includes(schedule.state) || pending ? 'schedule_inactive'
      : !schedule.noticeOutboxId || !schedule.noticeSentAt ? 'no_eligible_notice'
      : schedule.state === 'retry_scheduled' && schedule.nextAttemptAt && schedule.nextAttemptAt > new Date() ? 'retry_not_due'
      : lead !== null && Date.now() < schedule.noticeSentAt.getTime() + lead * 86_400_000 ? 'notice_lead'
      : !enabled ? 'charging_disabled' : null;
  }
  // Only a chargeable schedule carries collection terms; a not_needed one holds the
  // issuance placeholder, which parseAutopayTerms refuses (2a-4).
  const terms = canChargeNow && schedule ? parseAutopayTerms(schedule.termsSnapshot) : null;
  const chargePreview = terms ? {
    amount: fromMinorUnits(Math.min(toMinorUnits(invoice.balance, invoice.currencyCode),
      toMinorUnits(terms.principal, invoice.currencyCode)) + toMinorUnits(terms.feeAmount, invoice.currencyCode), invoice.currencyCode),
    currency: invoice.currencyCode, methodLabel: terms.methodLabel,
  } : null;
  // F-8: kept manual, but no longer "above the limit the client authorized" once a newer
  // authorization covers the amount.
  let reason = pending ? `control_pending:${pending}` : schedule?.stateReason ?? schedule?.ineligibleReason ?? null;
  if (reason === 'above_authorized_cap' && schedule?.state === 'not_needed' && schedule.enrollmentId) {
    const [enrollment] = await tx.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
    const method = enrollment && enrollment.orgId === invoice.orgId ? await getAutopayMethod(tx, invoice.orgId) : null;
    if (enrollment && method && await coveredByAcceptedCap(tx, { orgId: invoice.orgId, enrollmentId: enrollment.id,
      generation: enrollment.generation, methodId: method.id }, invoice.total, invoice.currencyCode)) reason = 'issued_before_authorization';
  }
  // FP-18 (P-16): only a payment still planned has a "charge on or around" date.
  const planned = !!schedule && ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled', 'action_required'].includes(schedule.state);
  return { state: unapplied ? 'unapplied' : processing ? 'processing' : actionRequired ? 'action_required' : schedule?.state ?? 'not_needed',
    reason, collectOn: planned ? schedule!.collectOn ?? null : null,
    noticeSentAt: schedule?.noticeSentAt?.toISOString() ?? null, excluded: invoice.autopayExcluded,
    canExclude: enabled && ['draft', 'sent', 'partially_paid', 'overdue'].includes(invoice.status)
      && !processing && !unapplied && !pending,
    canChargeNow, chargeBlockedReason, processing, unapplied, chargePreview };
}
