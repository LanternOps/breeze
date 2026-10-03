import { and, desc, eq } from 'drizzle-orm';
import { SCHEDULE_CONTROL_MARKERS } from '@breeze/shared';
import { invoices, invoiceCollectionAttempts, invoiceAutopaySchedules, orgAutopayEnrollments, orgPaymentMethods } from '../../db/schema';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { toMinorUnits } from '../stripeMoney';
import type { NoticePreSendValidator } from './noticeOutbox';
import type { RenderedNotice } from './types';

/** Receipts deliberately do not use this validator: they report money already moved. */
export const validatePaymentActionNotice: NoticePreSendValidator = async (tx, row) => {
  const obsolete = 'Payment action no longer needed';
  const frozen = (row.rendered as RenderedNotice).frozen;
  if (!row.invoiceId || typeof frozen?.attemptId !== 'string') return obsolete;
  const [invoice] = await tx.select().from(invoices).where(and(
    eq(invoices.id, row.invoiceId), eq(invoices.orgId, row.orgId), buildPublicLinkLiveOrgPredicate(invoices.orgId),
  )).limit(1);
  if (!invoice || invoice.orgId !== row.orgId || invoice.id !== row.invoiceId
    || !['sent', 'partially_paid', 'overdue'].includes(invoice.status)
    || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0 || invoice.autopayExcluded) return obsolete;
  const [attempt] = await tx.select().from(invoiceCollectionAttempts).where(and(
    eq(invoiceCollectionAttempts.id, frozen.attemptId), eq(invoiceCollectionAttempts.invoiceId, invoice.id),
    eq(invoiceCollectionAttempts.orgId, row.orgId),
  )).limit(1);
  if (!attempt || attempt.id !== frozen.attemptId || attempt.orgId !== row.orgId || attempt.invoiceId !== invoice.id) return obsolete;
  const [latest] = await tx.select({ id: invoiceCollectionAttempts.id }).from(invoiceCollectionAttempts)
    .where(and(eq(invoiceCollectionAttempts.invoiceId, invoice.id), eq(invoiceCollectionAttempts.orgId, row.orgId)))
    .orderBy(desc(invoiceCollectionAttempts.createdAt), desc(invoiceCollectionAttempts.attemptNo)).limit(1);
  if (latest?.id !== attempt.id) return obsolete;
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
  if (frozen.variant === 'returned') return attempt.state === 'succeeded' ? null : obsolete;
  if (frozen.variant === 'expired') return attempt.state === 'canceled' ? null : obsolete;
  return frozen.variant === 'pay' && ['failed', 'canceled'].includes(attempt.state) ? null : obsolete;
};
