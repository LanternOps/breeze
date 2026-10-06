import { and, desc, eq } from 'drizzle-orm';
import { SCHEDULE_CONTROL_MARKERS } from '@breeze/shared';
import { billingLinkTokens, invoices, invoiceCollectionAttempts, invoiceAutopaySchedules, invoiceStripePayments, orgAutopayEnrollments, orgPaymentMethods } from '../../db/schema';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { toMinorUnits } from '../stripeMoney';
import type { NoticePreSendValidator } from './noticeOutbox';
import type { RenderedNotice } from './types';

/** An update-method link stopped being true before dispatch (autopay stopped, paused or
 * re-requested, the method replaced, the invoice fenced), but the failure it reports did
 * not: the original is cancelled and re-issued without the update link (2b-1, 2b-2). */
const REISSUED = 'Re-issued without the update-method link';

/** Receipts use validateReceiptNotice below: they report money already moved. */
export const validatePaymentActionNotice: NoticePreSendValidator = async (tx, row) => {
  const obsolete = 'Payment action no longer needed';
  const frozen = (row.rendered as RenderedNotice).frozen;
  if (row.invoiceId && frozen?.attemptId === null && typeof frozen.scheduleId === 'string'
    && (frozen.variant === 'update' || frozen.variant === 'pay')) {
    const verdict = await validateMethodUnusableNotice(tx, row, frozen.scheduleId);
    if (verdict !== 'authority_changed') return verdict;
    if (frozen.variant === 'pay') return null;
    const { enqueueMethodUnusablePayNotice } = await import('./paymentNotices');
    await enqueueMethodUnusablePayNotice(tx, frozen.scheduleId);
    return REISSUED;
  }
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
    // A return held until after capture is applied (and this notice enqueued) before the
    // attempt itself is marked succeeded (2b-3). A processing attempt qualifies only once
    // its payment was captured, so a payment that never succeeded is never "returned".
    if (!['succeeded', 'processing'].includes(attempt.state) || !attempt.invoiceStripePaymentId
      || typeof frozen.returnIdentity !== 'string') return obsolete;
    const [mapping] = await tx.select().from(invoiceStripePayments).where(and(
      eq(invoiceStripePayments.id, attempt.invoiceStripePaymentId), eq(invoiceStripePayments.orgId, row.orgId),
    )).limit(1);
    if (!(mapping && mapping.id === attempt.invoiceStripePaymentId && mapping.orgId === row.orgId
      && mapping.invoiceId === invoice.id && mapping.disputeFundsWithdrawn
      && (attempt.state === 'succeeded' || mapping.paymentCapturedAt)
      && frozen.returnIdentity.startsWith(`${mapping.id}:`))) return obsolete;
    if (typeof frozen.tokenId !== 'string' || await updateLinkStillTrue(tx, row.orgId, frozen.tokenId)) return null;
    const { enqueueAttemptNotice } = await import('./paymentNotices');
    await enqueueAttemptNotice(tx, attempt.id, 'returned', frozen.returnIdentity, { fallback: true });
    return REISSUED;
  }
  if (frozen.variant === 'expired') return attempt.state === 'canceled' ? null : obsolete;
  if (frozen.variant === 'pay') return ['failed', 'canceled'].includes(attempt.state) ? null : obsolete;
  if (frozen.variant !== 'confirm' && frozen.variant !== 'update') return obsolete;
  if (frozen.variant === 'confirm' && attempt.state !== 'requires_action') return obsolete;
  if (frozen.variant === 'update'
    && (!['failed', 'canceled'].includes(attempt.state) || !['hard', 'revoked'].includes(attempt.failureClass ?? ''))) return obsolete;
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.orgId, row.orgId),
  )).limit(1);
  if (attempt.scheduleId && (!schedule || schedule.id !== attempt.scheduleId
    || schedule.attemptCount !== attempt.attemptNo)) return obsolete;
  if (schedule && (schedule.orgId !== row.orgId || schedule.invoiceId !== invoice.id)) return obsolete;
  // confirm / update ask the client to act on autopay, so they hold only while
  // that autopay authority (invoice, schedule, enrollment generation) still does.
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.orgId, row.orgId)).limit(1);
  let authority = !invoice.autopayExcluded && !(schedule && (schedule.clientSkippedAt || schedule.mspExcludedAt
    || ['skipped_by_client', 'excluded_by_msp', 'cancelled'].includes(schedule.state)
    || SCHEDULE_CONTROL_MARKERS.some(marker => schedule.stateReason === `control_pending:${marker}`)))
    && !!enrollment && enrollment.orgId === row.orgId && enrollment.status === 'active'
    && !(schedule && (schedule.enrollmentId !== enrollment.id || schedule.enrollmentGeneration !== enrollment.generation));
  if (authority && frozen.variant === 'update') authority = !await hasActiveReplacement(tx, row.orgId);
  if (authority) return null;
  // A confirm link is the only thing a confirm notice offers; without its authority
  // there is nothing left to say (the cancelled schedule's own notices speak).
  if (frozen.variant === 'confirm') return obsolete;
  const { enqueueAttemptNotice } = await import('./paymentNotices');
  await enqueueAttemptNotice(tx, attempt.id, 'pay', undefined, { fallback: true });
  return REISSUED;
};

/** The update-method link in a returned-payment email is still worth sending: the link
 * is live, its enrollment generation is still active, and the method still needs replacing. */
async function updateLinkStillTrue(tx: Parameters<NoticePreSendValidator>[0], orgId: string, tokenId: string): Promise<boolean> {
  const [token] = await tx.select().from(billingLinkTokens).where(and(
    eq(billingLinkTokens.id, tokenId), eq(billingLinkTokens.orgId, orgId))).limit(1);
  if (!token || token.id !== tokenId || token.orgId !== orgId || token.purpose !== 'enroll' || !token.enrollmentId
    || token.revokedAt || token.consumedAt || token.expiresAt.getTime() <= Date.now()) return false;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.orgId, orgId)).limit(1);
  if (!enrollment || enrollment.id !== token.enrollmentId || enrollment.status !== 'active'
    || enrollment.generation !== token.generation) return false;
  return !await hasActiveReplacement(tx, orgId);
}

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
  // A refund notice reports money already sent back; a later return or failure does not undo it.
  if ((row.rendered as RenderedNotice).frozen?.variant === 'refund') return null;
  const returned = mapping.paymentMethodType === 'us_bank_account' && mapping.disputeFundsWithdrawn;
  return returned || mapping.status === 'failed' ? 'Receipt payment was returned or failed' : null;
};

/** enqueueMethodUnusableNotice: a due schedule failed because the shared method
 * became unusable. The failure stays true while the invoice is payable and the
 * schedule is still failed for that reason. The update link also needs the same
 * enrollment generation and no active replacement method (mirrors the attempt-bound
 * update variant); without them the caller re-issues the pay variant. */
async function validateMethodUnusableNotice(tx: Parameters<NoticePreSendValidator>[0],
  row: Parameters<NoticePreSendValidator>[1], scheduleId: string): Promise<string | null | 'authority_changed'> {
  const obsolete = 'Payment action no longer needed';
  const [invoice] = await tx.select().from(invoices).where(and(
    eq(invoices.id, row.invoiceId!), eq(invoices.orgId, row.orgId), buildPublicLinkLiveOrgPredicate(invoices.orgId),
  )).limit(1);
  if (!invoice || invoice.orgId !== row.orgId || invoice.id !== row.invoiceId
    || !['sent', 'partially_paid', 'overdue'].includes(invoice.status)
    || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0) return obsolete;
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.id, scheduleId), eq(invoiceAutopaySchedules.invoiceId, invoice.id),
    eq(invoiceAutopaySchedules.orgId, row.orgId),
  )).limit(1);
  if (!schedule || schedule.id !== scheduleId || schedule.invoiceId !== invoice.id || schedule.orgId !== row.orgId
    || schedule.state !== 'failed' || schedule.stateReason !== 'method_not_usable') return obsolete;
  if (invoice.autopayExcluded || schedule.clientSkippedAt || schedule.mspExcludedAt) return 'authority_changed';
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.orgId, row.orgId)).limit(1);
  if (!enrollment || enrollment.orgId !== row.orgId || enrollment.status !== 'active'
    || schedule.enrollmentId !== enrollment.id || schedule.enrollmentGeneration !== enrollment.generation) return 'authority_changed';
  return await hasActiveReplacement(tx, row.orgId) ? 'authority_changed' : null;
}

/** An active autopay method means the client already replaced the unusable one. Filtered by
 * status (D-17): one flagged row per org is a database invariant, but readers never rely on
 * picking the right row from an unordered LIMIT 1. */
async function hasActiveReplacement(tx: Parameters<NoticePreSendValidator>[0], orgId: string): Promise<boolean> {
  const methods = await tx.select({ status: orgPaymentMethods.status }).from(orgPaymentMethods).where(and(
    eq(orgPaymentMethods.orgId, orgId), eq(orgPaymentMethods.isAutopayMethod, true), eq(orgPaymentMethods.status, 'active'),
  ));
  return methods.some(method => method.status === 'active');
}
