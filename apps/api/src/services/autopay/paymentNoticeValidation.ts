import { and, desc, eq } from 'drizzle-orm';
import { SCHEDULE_CONTROL_MARKERS } from '@breeze/shared';
import { invoices, invoiceCollectionAttempts, invoiceAutopaySchedules, invoiceStripePayments, orgAutopayEnrollments, orgPaymentMethods } from '../../db/schema';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { toMinorUnits } from '../stripeMoney';
import type { NoticePreSendValidator } from './noticeOutbox';
import type { RenderedNotice } from './types';

/** Receipts use validateReceiptNotice below: they report money already moved. */
export const validatePaymentActionNotice: NoticePreSendValidator = async (tx, row) => {
  const obsolete = 'Payment action no longer needed';
  const frozen = (row.rendered as RenderedNotice).frozen;
  if (!row.invoiceId || typeof frozen?.attemptId !== 'string') return obsolete;
  const [invoice] = await tx.select().from(invoices).where(and(
    eq(invoices.id, row.invoiceId), eq(invoices.orgId, row.orgId), buildPublicLinkLiveOrgPredicate(invoices.orgId),
  )).limit(1);
  if (!invoice || invoice.orgId !== row.orgId || invoice.id !== row.invoiceId
    || !['sent', 'partially_paid', 'overdue'].includes(invoice.status)
    || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0) return obsolete;
  const [attempt] = await tx.select().from(invoiceCollectionAttempts).where(and(
    eq(invoiceCollectionAttempts.id, frozen.attemptId), eq(invoiceCollectionAttempts.invoiceId, invoice.id),
    eq(invoiceCollectionAttempts.orgId, row.orgId),
  )).limit(1);
  if (!attempt || attempt.id !== frozen.attemptId || attempt.orgId !== row.orgId || attempt.invoiceId !== invoice.id) return obsolete;
  const [latest] = await tx.select({ id: invoiceCollectionAttempts.id }).from(invoiceCollectionAttempts)
    .where(and(eq(invoiceCollectionAttempts.invoiceId, invoice.id), eq(invoiceCollectionAttempts.orgId, row.orgId)))
    .orderBy(desc(invoiceCollectionAttempts.createdAt), desc(invoiceCollectionAttempts.attemptNo)).limit(1);
  if (latest?.id !== attempt.id) return obsolete;
  // returned / pay / expired report money facts about an open invoice. Stopping,
  // pausing, skipping or excluding autopay afterwards does not make them untrue, so
  // only the invoice, the attempt and the reversed payment decide them.
  if (frozen.variant === 'returned') {
    if (attempt.state !== 'succeeded' || !attempt.invoiceStripePaymentId || typeof frozen.returnIdentity !== 'string') return obsolete;
    const [mapping] = await tx.select().from(invoiceStripePayments).where(and(
      eq(invoiceStripePayments.id, attempt.invoiceStripePaymentId), eq(invoiceStripePayments.orgId, row.orgId),
    )).limit(1);
    return mapping && mapping.id === attempt.invoiceStripePaymentId && mapping.orgId === row.orgId
      && mapping.invoiceId === invoice.id && mapping.disputeFundsWithdrawn
      && frozen.returnIdentity.startsWith(`${mapping.id}:`) ? null : obsolete;
  }
  if (frozen.variant === 'expired') return attempt.state === 'canceled' ? null : obsolete;
  if (frozen.variant === 'pay') return ['failed', 'canceled'].includes(attempt.state) ? null : obsolete;
  if (frozen.variant !== 'confirm' && frozen.variant !== 'update') return obsolete;
  // confirm / update ask the client to act on autopay, so they hold only while
  // that autopay authority (invoice, schedule, enrollment generation) still does.
  if (invoice.autopayExcluded) return obsolete;
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.orgId, row.orgId),
  )).limit(1);
  if (attempt.scheduleId && (!schedule || schedule.id !== attempt.scheduleId
    || schedule.attemptCount !== attempt.attemptNo)) return obsolete;
  if (schedule && (schedule.orgId !== row.orgId || schedule.invoiceId !== invoice.id
    || schedule.clientSkippedAt || schedule.mspExcludedAt
    || ['skipped_by_client', 'excluded_by_msp', 'cancelled'].includes(schedule.state)
    || SCHEDULE_CONTROL_MARKERS.some(marker => schedule.stateReason === `control_pending:${marker}`))) return obsolete;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.orgId, row.orgId)).limit(1);
  if (!enrollment || enrollment.orgId !== row.orgId || enrollment.status !== 'active'
    || (schedule && (schedule.enrollmentId !== enrollment.id || schedule.enrollmentGeneration !== enrollment.generation))) return obsolete;
  if (frozen.variant === 'confirm') return attempt.state === 'requires_action' ? null : obsolete;
  if (frozen.variant === 'update') {
    if (!['failed', 'canceled'].includes(attempt.state) || !['hard', 'revoked'].includes(attempt.failureClass ?? '')) return obsolete;
    const [method] = await tx.select().from(orgPaymentMethods).where(and(
      eq(orgPaymentMethods.orgId, row.orgId), eq(orgPaymentMethods.isAutopayMethod, true),
    )).limit(1);
    return method?.status === 'active' ? obsolete : null;
  }
  return obsolete;
};

/** A receipt stays a true record after a refund (or a card chargeback), so this
 * cancels only when the payment it reports never really completed: an ACH return
 * withdrew the funds, or the payment failed, before the receipt went out. A return
 * held until after capture is applied post-commit, so it can land before dispatch.
 * The returned-payment email is a separate notice and is not affected. */
export const validateReceiptNotice: NoticePreSendValidator = async (tx, row) => {
  const mappingId = (row.rendered as RenderedNotice).frozen?.mappingId;
  if (typeof mappingId !== 'string') return null;
  const [mapping] = await tx.select().from(invoiceStripePayments)
    .where(eq(invoiceStripePayments.id, mappingId)).limit(1);
  if (!mapping) return null;
  if (mapping.orgId !== row.orgId || mapping.invoiceId !== row.invoiceId) return 'Receipt payment ownership mismatch';
  const returned = mapping.paymentMethodType === 'us_bank_account' && mapping.disputeFundsWithdrawn;
  return returned || mapping.status === 'failed' ? 'Receipt payment was returned or failed' : null;
};
