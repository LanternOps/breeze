import { parseAutopayTerms } from '@breeze/shared';
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
import { planAutopayForInvoice, noticeLeadDays } from './scheduler';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
import { isAutopayEnabledForPartner } from './autopayGate';
import { collectionFenced, hasUnstoppableCollection, isControllableSchedule, pendingInvoiceControl, requestInvoiceControl, type InvoiceControlResult } from './collectionControl';
import type { AutopaySkipView, AutopaySkipViewStatus } from '@breeze/shared';
import type { Tx } from './types';

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

export async function getSkipInvoiceView(tx: Tx, token: string): Promise<AutopaySkipView> {
  const { invoice, schedule } = await skipAuthority(tx, token, false);
  // partnerName: who the client contacts if the skip is refused.
  const [partner] = await tx.select({ name: partners.name }).from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  // processing: a payment is already with Stripe and the skip would be refused.
  const processing = await hasUnstoppableCollection(tx, invoice.id);
  const control = pendingInvoiceControl(schedule.stateReason);
  return { status: skipViewStatus(invoice, schedule, control, processing), state: schedule.state,
    collectOn: schedule.collectOn, partnerName: partner?.name ?? null, control, processing };
}
/** D-22: a stale skip link (paid, closed or void invoice, or one not scheduled for
 * automatic payment) reports that skipping is no longer needed instead of offering it.
 * 'processing' uses the same predicate as the skip POST's 409 details.reason
 * 'payment_processing', and wins over a pending control: that money moves regardless. */
function skipViewStatus(invoice: typeof invoices.$inferSelect, schedule: typeof invoiceAutopaySchedules.$inferSelect,
  control: ReturnType<typeof pendingInvoiceControl>, processing: boolean): AutopaySkipViewStatus {
  if (invoice.status === 'paid' || schedule.state === 'succeeded') return 'paid';
  if (processing) return 'processing';
  if (schedule.state === 'skipped_by_client') return 'skipped';
  if (!['sent', 'partially_paid', 'overdue'].includes(invoice.status) || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0
    || invoice.autopayExcluded || !schedule.eligible || !isControllableSchedule(schedule.state)
    || control === 'exclude' || control === 'stop') return 'not_needed';
  if (control === 'skip') return 'pending';
  return schedule.state === 'action_required' ? 'action_required' : 'ready';
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
  // Only a chargeable schedule carries collection terms; a not_needed one holds the
  // issuance placeholder, which parseAutopayTerms refuses (2a-4).
  const terms = canChargeNow && schedule ? parseAutopayTerms(schedule.termsSnapshot) : null;
  const chargePreview = terms ? {
    amount: fromMinorUnits(Math.min(toMinorUnits(invoice.balance, invoice.currencyCode),
      toMinorUnits(terms.principal, invoice.currencyCode)) + toMinorUnits(terms.feeAmount, invoice.currencyCode), invoice.currencyCode),
    currency: invoice.currencyCode, methodLabel: terms.methodLabel,
  } : null;
  return { state: unapplied ? 'unapplied' : processing ? 'processing' : actionRequired ? 'action_required' : schedule?.state ?? 'not_needed',
    reason: pending ? `control_pending:${pending}` : schedule?.stateReason ?? schedule?.ineligibleReason ?? null, collectOn: schedule?.collectOn ?? null,
    noticeSentAt: schedule?.noticeSentAt?.toISOString() ?? null, excluded: invoice.autopayExcluded,
    canExclude: enabled && ['draft', 'sent', 'partially_paid', 'overdue'].includes(invoice.status)
      && !processing && !unapplied && !pending,
    canChargeNow, processing, unapplied, chargePreview };
}
