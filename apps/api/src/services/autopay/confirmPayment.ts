import { collectionFenced, pendingInvoiceControl } from './collectionControl';
import { toMinorUnits } from '../stripeMoney';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { billingNoticeOutbox, billingLinkTokens, invoiceCollectionAttempts, invoiceAutopaySchedules,
  orgAutopayEnrollments, orgPaymentMethods, invoices } from '../../db/schema';
import { resolveBillingLinkToken } from './linkTokens';
import { loadAttemptForReconciliation, resumeCollectionAttempt } from './collectionEngine';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl, peekInvoiceLink } from '../invoiceLinkToken';
import { loadAutopayBranding } from './customerBranding';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { InvoiceServiceError } from '../invoiceTypes';
import { formatPaymentMethod, type AutopayConfirmationRelease, type AutopayConfirmView } from '@breeze/shared';

const unavailable = () => new InvoiceServiceError('Link unavailable', 404, 'INVALID_STATE');

/** The newest attempt is the only one a customer may recover; older attempts are history. */
async function latestAttempt(invoiceId: string) {
  const [latest] = await db.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceId, invoiceId))
    .orderBy(desc(invoiceCollectionAttempts.createdAt), desc(invoiceCollectionAttempts.attemptNo)).limit(1);
  return latest;
}

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
  const latest = await latestAttempt(invoice.id);
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

/** The confirm page's view: the attempt's state and amount, the invoice and method it
 * belongs to, and the MSP asking. Read-only: never mints a link or touches Stripe. */
export async function getConfirmPaymentView(token: string): Promise<AutopayConfirmView> {
  return withSystemDbAccessContext(async () => {
    const { invoice, attempt, fenced } = await resolveConfirmation(token);
    const [method] = attempt.paymentMethodId ? await db.select().from(orgPaymentMethods).where(and(
      eq(orgPaymentMethods.id, attempt.paymentMethodId), eq(orgPaymentMethods.orgId, invoice.orgId))).limit(1) : [];
    const live = peekInvoiceLink(invoice);
    return { state: attempt.state === 'canceled' || fenced ? 'not_needed' : attempt.state, amount: attempt.principalAmount, currency: attempt.currency,
      invoiceNumber: invoice.invoiceNumber ?? null, methodLabel: method && method.orgId === invoice.orgId ? formatPaymentMethod(method) : null,
      ...await loadAutopayBranding(db, { orgId: invoice.orgId, partnerId: invoice.partnerId }),
      invoiceUrl: live ? buildPublicInvoiceUrl(live.token) : null };
  });
}

/** Cancel-only recovery of the exact off-session PaymentIntent, then report what
 * Stripe actually did. Shared by the emailed confirm link and the invoice pages.
 * Uses original account/retained credentials, validates provider bindings, and
 * atomically finalizes the schedule with the reservation after verified cancel.
 * This is recovery of an existing PI; it deliberately has no rollout gate.
 */
async function cancelForOnSessionPayment(attemptId: string)
  : Promise<{ state: 'processing' } | { state: 'succeeded'; paid: boolean } | { state: 'canceled' }> {
  await resumeCollectionAttempt(attemptId, true);
  const current = await loadAttemptForReconciliation(attemptId);
  if (current.attempt.state === 'processing') return { state: 'processing' };
  if (current.attempt.state === 'unapplied') throw new InvoiceServiceError('Payment received but needs billing review', 409, 'INVALID_STATE');
  if (current.attempt.state === 'succeeded') return { state: 'succeeded', paid: !!current.mapping.invoicePaymentId };
  if (current.attempt.state !== 'canceled') throw new InvoiceServiceError('Payment is still processing', 409, 'INVALID_STATE');
  return { state: 'canceled' };
}

export async function confirmInvoicePayment(token: string): Promise<{ url?: string; processing?: boolean; paid?: boolean; notNeeded?: boolean }> {
  assertNoHeldDbContextForStripe('confirmInvoicePayment');
  const binding = await withSystemDbAccessContext(() => resolveConfirmation(token));
  if (binding.attempt.state === 'canceled' || binding.fenced) return { notNeeded: true };
  const observed = await cancelForOnSessionPayment(binding.attempt.id);
  if (observed.state === 'processing') return { processing: true };
  if (observed.state === 'succeeded') return { paid: observed.paid };
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

/** Invoice-page exit (public link or portal session; the caller has authorized
 * the invoice for this org). While the newest attempt waits on bank
 * authentication, cancel that off-session PaymentIntent so the reservation is
 * released and the client can pay on-session. Cancelling an unauthenticated
 * PaymentIntent cannot move money, so no confirm token is required here.
 */
export async function releaseInvoiceConfirmation(input: { invoiceId: string; orgId: string }): Promise<AutopayConfirmationRelease> {
  assertNoHeldDbContextForStripe('releaseInvoiceConfirmation');
  const attempt = await withSystemDbAccessContext(async () => {
    const [invoice] = await db.select().from(invoices)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, input.orgId))).limit(1);
    if (!invoice || invoice.id !== input.invoiceId || invoice.orgId !== input.orgId) {
      throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    }
    const latest = await latestAttempt(invoice.id);
    return latest && latest.invoiceId === invoice.id && latest.orgId === invoice.orgId
      && latest.state === 'requires_action' && latest.stripePaymentIntentId ? latest : null;
  });
  if (!attempt) return { outcome: 'not_needed' };
  const observed = await cancelForOnSessionPayment(attempt.id);
  if (observed.state === 'processing') return { outcome: 'processing' };
  if (observed.state === 'succeeded') return { outcome: 'paid' };
  return { outcome: 'released' };
}
