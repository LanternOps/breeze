import { and, eq, inArray } from 'drizzle-orm';
import { ACTIVE_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { invoices, invoiceAutopaySchedules, invoiceCollectionAttempts, billingNoticeOutbox,
  orgAutopayEnrollments, invoiceLines, contracts } from '../../db/schema';
import { InvoiceServiceError, type InvoiceActor } from '../invoiceTypes';
import { requireInvoiceAccess } from '../invoiceService';
import { assertNoActiveCollection } from './reservation';
import { resolveBillingLinkToken } from './linkTokens';
import { computeCollectOn } from './scheduler';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
import { isAutopayEnabledForPartner } from './autopayGate';
import { collectionFenced, pendingInvoiceControl, requestInvoiceControl, type InvoiceControlResult } from './collectionControl';
import type { Tx } from './types';

export async function assertControllable(tx: Tx, invoiceId: string): Promise<void> {
  await assertNoActiveCollection(tx, invoiceId);
}

export async function renoticeSchedule(tx: Tx, invoiceId: string): Promise<void> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1).for('update');
  if (!invoice || !schedule?.enrollmentId || schedule.state !== 'scheduled'
    || pendingInvoiceControl(schedule.stateReason)
    || collectionFenced({ ...schedule, autopayExcluded: invoice.autopayExcluded, enrollmentStatus: 'active' })) return;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
  if (!enrollment || enrollment.orgId !== invoice.orgId || enrollment.status !== 'active'
    || enrollment.generation !== schedule.enrollmentGeneration) return;
  const terms = schedule.termsSnapshot as unknown as AutopayTerms;
  const collectOn = computeCollectOn({ issueDate: invoice.issueDate!, dueDate: invoice.dueDate!,
    offsetDays: terms.offsetDays, rule: terms.rule,
    noticeDate: new Date().toISOString().slice(0, 10), leadDays: terms.noticeLeadDays });
  if (schedule.noticeOutboxId) await tx.update(billingNoticeOutbox).set({ status: 'cancelled' }).where(and(
    eq(billingNoticeOutbox.id, schedule.noticeOutboxId), inArray(billingNoticeOutbox.status, ['pending', 'failed']),
  ));
  await tx.update(invoiceAutopaySchedules).set({ state: 'awaiting_notice', noticeSentAt: null,
    noticeOutboxId: null, collectOn, termsSnapshot: { ...terms, chargeDate: collectOn, noticeSeq: terms.noticeSeq + 1 } })
    .where(eq(invoiceAutopaySchedules.id, schedule.id));
  await enqueueAutopayNotice(tx, schedule.id);
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

export async function getSkipInvoiceView(tx: Tx, token: string) {
  const { schedule } = await skipAuthority(tx, token, false);
  return { state: schedule.state, collectOn: schedule.collectOn,
    control: pendingInvoiceControl(schedule.stateReason) };
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
  if (!schedule?.enrollmentId || schedule.state !== 'excluded_by_msp' || schedule.clientSkippedAt) return { status: 'included' };
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

export interface InvoiceAutopayView {
  state: string; reason: string | null; collectOn: string | null;
  noticeSentAt: string | null; excluded: boolean; canExclude: boolean;
  canChargeNow: boolean; processing: boolean; unapplied: boolean;
}

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
  const pending = pendingInvoiceControl(schedule?.stateReason ?? null);
  return { state: unapplied ? 'unapplied' : processing ? 'processing' : actionRequired ? 'action_required' : schedule?.state ?? 'not_needed',
    reason: schedule?.stateReason ?? schedule?.ineligibleReason ?? null, collectOn: schedule?.collectOn ?? null,
    noticeSentAt: schedule?.noticeSentAt?.toISOString() ?? null, excluded: invoice.autopayExcluded,
    canExclude: enabled && ['draft', 'sent', 'partially_paid', 'overdue'].includes(invoice.status)
      && !processing && !actionRequired && !unapplied && !pending,
    canChargeNow: false, processing, unapplied };
}
