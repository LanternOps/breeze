import { collectionFenced, pendingInvoiceControl } from './collectionControl';
import { toMinorUnits } from '../stripeMoney';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { billingNoticeOutbox, billingLinkTokens, invoiceCollectionAttempts, invoiceAutopaySchedules,
  orgAutopayEnrollments, invoices } from '../../db/schema';
import { resolveBillingLinkToken } from './linkTokens';
import { loadAttemptForReconciliation, resumeCollectionAttempt } from './collectionEngine';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { InvoiceServiceError } from '../invoiceTypes';

const unavailable = () => new InvoiceServiceError('Link unavailable', 404, 'INVALID_STATE');

/** Only the notice's exact attempt and current token generation may recover money. */
async function resolveConfirmation(token: string, lock = false) {
  const link = await resolveBillingLinkToken(db, token, 'confirm_payment');
  if (!link?.invoiceId || !link.enrollmentId) throw unavailable();
  const query = db.select().from(invoices).where(and(eq(invoices.id, link.invoiceId), eq(invoices.orgId, link.orgId))).limit(1);
  const [invoice] = await (lock ? query.for('update') : query);
  if (!invoice || invoice.orgId !== link.orgId) throw unavailable();
  const [enrollment] = await db.select().from(orgAutopayEnrollments)
    .where(and(eq(orgAutopayEnrollments.id, link.enrollmentId), eq(orgAutopayEnrollments.orgId, link.orgId))).limit(1);
  if (!enrollment || enrollment.id !== link.enrollmentId || enrollment.orgId !== link.orgId
    || enrollment.generation !== link.generation) throw unavailable();
  const [notice] = await db.select().from(billingNoticeOutbox).where(and(
    eq(billingNoticeOutbox.invoiceId, link.invoiceId), eq(billingNoticeOutbox.orgId, link.orgId),
    eq(billingNoticeOutbox.kind, 'payment_failed'),
    sql`${billingNoticeOutbox.rendered}->'frozen'->>'tokenId' = ${link.id}`,
  )).limit(1);
  const frozen = (notice?.rendered as { frozen?: { attemptId?: string; tokenId?: string; variant?: string } } | undefined)?.frozen;
  if (!frozen?.attemptId || frozen.tokenId !== link.id || frozen.variant !== 'confirm') throw unavailable();
  const [attempt] = await db.select().from(invoiceCollectionAttempts).where(and(
    eq(invoiceCollectionAttempts.id, frozen.attemptId), eq(invoiceCollectionAttempts.invoiceId, invoice.id),
    eq(invoiceCollectionAttempts.orgId, invoice.orgId),
  )).limit(1);
  if (!attempt || !attempt.stripePaymentIntentId || !['requires_action','processing','succeeded','canceled','unapplied'].includes(attempt.state) || attempt.id !== frozen.attemptId || attempt.invoiceId !== invoice.id || attempt.orgId !== invoice.orgId) throw unavailable();
  const [latest] = await db.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceId, invoice.id))
    .orderBy(desc(invoiceCollectionAttempts.createdAt), desc(invoiceCollectionAttempts.attemptNo)).limit(1);
  if (latest?.id !== attempt.id) throw unavailable();
  let fenced = collectionFenced({ invoice, enrollment })
    || !['sent', 'partially_paid', 'overdue'].includes(invoice.status)
    || toMinorUnits(invoice.balance, invoice.currencyCode) <= 0;
  if (attempt.scheduleId) {
    const [schedule] = await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, attempt.scheduleId)).limit(1);
    if (!schedule || schedule.id !== attempt.scheduleId || schedule.invoiceId !== invoice.id || schedule.orgId !== link.orgId
      || schedule.enrollmentId !== link.enrollmentId || schedule.enrollmentGeneration !== link.generation
      || schedule.attemptCount !== attempt.attemptNo) throw unavailable();
    fenced ||= collectionFenced({ invoice, enrollment, schedule })
      || !!pendingInvoiceControl(schedule.stateReason)
      || ['skipped_by_client', 'excluded_by_msp'].includes(schedule.state)
      // This request itself cancels the original PI before opening Checkout.
      // Already-canceled attempts are rejected at the initial binding instead.
      || (schedule.state === 'cancelled' && schedule.stateReason !== 'provider_canceled');
  }
  return { link, invoice, attempt, fenced };
}

export async function getConfirmPaymentView(token: string) {
  return withSystemDbAccessContext(async () => {
    const { attempt, fenced } = await resolveConfirmation(token);
    return { state: attempt.state === 'canceled' || fenced ? 'not_needed' : attempt.state, amount: attempt.principalAmount, currency: attempt.currency };
  });
}

export async function confirmInvoicePayment(token: string): Promise<{ url?: string; processing?: boolean; paid?: boolean; notNeeded?: boolean }> {
  assertNoHeldDbContextForStripe('confirmInvoicePayment');
  const binding = await withSystemDbAccessContext(() => resolveConfirmation(token));
  if (binding.attempt.state === 'canceled' || binding.fenced) return { notNeeded: true };
  // Uses original account/retained credentials, validates provider bindings, and
  // atomically finalizes the schedule with the reservation after verified cancel.
  // This is recovery of an existing PI; it deliberately has no rollout gate.
  await resumeCollectionAttempt(binding.attempt.id, true);
  const current = await loadAttemptForReconciliation(binding.attempt.id);
  if (current.attempt.state === 'processing') return { processing: true };
  if (current.attempt.state === 'unapplied') throw new InvoiceServiceError('Payment received but needs billing review', 409, 'INVALID_STATE');
  if (current.attempt.state === 'succeeded') return { paid: !!current.mapping.invoicePaymentId };
  if (current.attempt.state !== 'canceled') throw new InvoiceServiceError('Payment is still processing', 409, 'INVALID_STATE');
  return withSystemDbAccessContext(async () => {
    const fresh = await resolveConfirmation(token, true);
    if (fresh.attempt.id !== binding.attempt.id || fresh.attempt.state !== 'canceled') throw unavailable();
    if (fresh.fenced) return { notNeeded: true };
    const consumed = await db.update(billingLinkTokens).set({ consumedAt: new Date() }).where(and(
      eq(billingLinkTokens.id, fresh.link.id), isNull(billingLinkTokens.consumedAt), isNull(billingLinkTokens.revokedAt),
      sql`${billingLinkTokens.expiresAt} > NOW()`,
    )).returning({ id: billingLinkTokens.id });
    if (!consumed.length) throw unavailable();
    const link = await getOrMintInvoiceLink(fresh.invoice);
    return { url: buildPublicInvoiceUrl(link.token) };
  });
}
