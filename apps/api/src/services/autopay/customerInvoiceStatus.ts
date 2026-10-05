import { isDeferralEndReason } from './notChargedNotice';
import { and, desc, eq } from 'drizzle-orm';
import { autopayTermsSnapshotSchema, formatPaymentMethod, type CustomerInvoiceAutopayStatus } from '@breeze/shared';
import { invoices, invoiceAutopaySchedules, invoiceCollectionAttempts, invoiceStripePayments, orgAutopayEnrollments, orgPaymentMethods } from '../../db/schema';
import { readInFlightCollection } from './reservation';
import { getAutopayMethod } from './paymentMethods';
import { isAutopayEnabledForPartner } from './autopayGate';
import { fromMinorUnits, toMinorUnits } from '../stripeMoney';
import { coveredByAcceptedCap } from './authorizedCap';
import type { Tx } from './types';

const OPEN = new Set(['sent', 'partially_paid', 'overdue']);
const ON_HOLD = new Set(['charging_disabled', 'stripe_unavailable']);

/**
 * The client's view of this invoice's automatic payment, for the public and portal
 * invoice pages: "will be paid automatically on <date> with <method>", processing,
 * waiting on the bank, delayed, skipped, not included, paid automatically.
 *
 * `enrolled`: the org has active automatic payments with a usable method and nothing
 * needing attention. The pages then stop offering to set up automatic payments again
 * (spec 6.4 decision: hide the save-card and bank offers while enrolled).
 *
 * The caller has authorized the invoice for this org. Read-only.
 */
export async function getCustomerInvoiceAutopay(db: Tx, ids: { invoiceId: string; orgId: string })
  : Promise<{ enrolled: boolean; status: CustomerInvoiceAutopayStatus | null }> {
  const [invoice] = await db.select().from(invoices).where(and(eq(invoices.id, ids.invoiceId), eq(invoices.orgId, ids.orgId))).limit(1);
  if (!invoice || invoice.orgId !== ids.orgId) return { enrolled: false, status: null };
  const [enrollment] = await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
  const method = enrollment ? await getAutopayMethod(db, invoice.orgId) : null;
  const enrolled = enrollment?.status === 'active' && !enrollment.needsAttentionReason
    && !!method && (method.status === 'active' || method.status === 'pending_verification');
  const [schedule] = await db.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.orgId, invoice.orgId))).limit(1);
  const inFlight = await readInFlightCollection(db, invoice.id);
  // A client-started bank payment can be in flight on an invoice with no schedule (V-29).
  if (!schedule && !inFlight.inProgress && invoice.status !== 'paid') return { enrolled, status: null };

  const parsed = schedule ? autopayTermsSnapshotSchema.safeParse(schedule.termsSnapshot) : null;
  const terms = parsed?.success && parsed.data.kind === 'terms' ? parsed.data : null;
  const base: Omit<CustomerInvoiceAutopayStatus, 'state' | 'reason'> = {
    chargeDate: schedule?.collectOn ?? null,
    amount: terms?.principal ?? null, fee: terms?.feeAmount ?? null, currency: invoice.currencyCode,
    methodLabel: terms ? (method && method.id === terms.methodId ? formatPaymentMethod(method)
      : formatPaymentMethod({ type: terms.methodType, cardLast4: terms.last4, bankLast4: terms.last4 })) : null,
    methodType: terms?.methodType ?? null,
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    canPayNow: !inFlight.inProgress,
    enrollmentActive: enrollment?.status === 'active',
  };
  const status = (state: CustomerInvoiceAutopayStatus['state'], reason: string | null = null, over: Partial<CustomerInvoiceAutopayStatus> = {}) =>
    ({ enrolled, status: { ...base, state, reason, ...over } });

  if (inFlight.inProgress) {
    // Describe the money actually moving, not the schedule's noticed terms (V-5).
    const [moving] = inFlight.paymentMethodId ? await db.select().from(orgPaymentMethods).where(and(
      eq(orgPaymentMethods.id, inFlight.paymentMethodId), eq(orgPaymentMethods.orgId, invoice.orgId))).limit(1) : [];
    return status(inFlight.actionRequired ? 'action_required' : 'processing', null, { amount: inFlight.amount, fee: inFlight.fee,
      ...(moving && moving.orgId === invoice.orgId ? { methodLabel: formatPaymentMethod(moving), methodType: moving.type } : {}) });
  }
  // F-9: money captured but not yet applied (the other half of holdsClientMoney): the client
  // was charged; never tell them it "didn't go through" or offer to pay again.
  if (OPEN.has(invoice.status)) {
    const [held] = await db.select({ principalAmount: invoiceCollectionAttempts.principalAmount, feeAmount: invoiceCollectionAttempts.feeAmount })
      .from(invoiceCollectionAttempts).where(and(eq(invoiceCollectionAttempts.invoiceId, invoice.id),
        eq(invoiceCollectionAttempts.orgId, invoice.orgId), eq(invoiceCollectionAttempts.state, 'unapplied')))
      .orderBy(desc(invoiceCollectionAttempts.createdAt)).limit(1);
    if (held) {
      const total = fromMinorUnits(toMinorUnits(held.principalAmount, invoice.currencyCode) + toMinorUnits(held.feeAmount ?? '0', invoice.currencyCode), invoice.currencyCode);
      return { enrolled, status: { ...base, state: 'unapplied', reason: null, amount: total, fee: null, chargeDate: null, canPayNow: false } };
    }
  }
  if (invoice.status === 'paid') {
    // R3: "Paid automatically" only while the automatic payment still stands. A returned debit
    // keeps the schedule 'succeeded' with payment_reversed, and a refund or dispute only
    // changes the Stripe mapping; an invoice paid again some other way must not read it.
    // FP-6: the client's own bank payment reads "paid by bank", not "automatically".
    const [payment] = await db.select({ status: invoiceStripePayments.status, refundedAmountMinor: invoiceStripePayments.refundedAmountMinor,
      initiatedBy: invoiceCollectionAttempts.initiatedBy, scheduleId: invoiceCollectionAttempts.scheduleId,
      paymentMethodId: invoiceCollectionAttempts.paymentMethodId })
      .from(invoiceCollectionAttempts)
      .innerJoin(invoiceStripePayments, eq(invoiceStripePayments.id, invoiceCollectionAttempts.invoiceStripePaymentId))
      .where(and(eq(invoiceCollectionAttempts.invoiceId, invoice.id), eq(invoiceCollectionAttempts.orgId, invoice.orgId),
        eq(invoiceCollectionAttempts.state, 'succeeded')))
      .orderBy(desc(invoiceCollectionAttempts.createdAt)).limit(1);
    const stands = payment?.status === 'succeeded' && Number(payment.refundedAmountMinor) === 0;
    if (stands && payment.initiatedBy === 'client_on_session') {
      const [paidWith] = payment.paymentMethodId ? await db.select().from(orgPaymentMethods).where(and(
        eq(orgPaymentMethods.id, payment.paymentMethodId), eq(orgPaymentMethods.orgId, invoice.orgId))).limit(1) : [];
      return { enrolled, status: { ...base, state: 'paid_by_bank', reason: null, amount: null, fee: null, chargeDate: null,
        ...(paidWith && paidWith.orgId === invoice.orgId ? { methodLabel: formatPaymentMethod(paidWith), methodType: paidWith.type } : { methodLabel: null, methodType: 'us_bank_account' as const }) } };
    }
    if (stands && schedule && schedule.state === 'succeeded' && schedule.stateReason !== 'payment_reversed'
      && payment.scheduleId === schedule.id) return status('paid_automatically');
    return { enrolled, status: null };
  }
  if (!schedule) return { enrolled, status: null };
  if (!OPEN.has(invoice.status)) return { enrolled, status: null };
  // FP-9: switched off, nothing is charged automatically; never promise a date.
  if (['awaiting_notice', 'scheduled', 'retry_scheduled'].includes(schedule.state)
    && !await isAutopayEnabledForPartner(db, invoice.partnerId)) return status('delayed', 'on_hold');
  switch (schedule.state) {
    case 'awaiting_notice': return status('awaiting_notice');
    case 'scheduled': {
      const reason = schedule.stateReason;
      if (reason === 'method_not_usable') return status('delayed', method?.status === 'pending_verification' ? 'pending_verification' : 'method_not_usable');
      if (reason && ON_HOLD.has(reason)) return status('delayed', 'on_hold');
      return status('scheduled');
    }
    case 'collecting': return status('processing');
    case 'retry_scheduled':
      return status('retry_scheduled', null, { chargeDate: schedule.nextAttemptAt ? schedule.nextAttemptAt.toISOString().slice(0, 10) : schedule.collectOn ?? null });
    case 'action_required': return status('action_required');
    case 'failed': return status('failed', schedule.stateReason ?? null);
    case 'skipped_by_client': return status('skipped');
    case 'excluded_by_msp': return status('not_included', 'excluded_invoice');
    // G1/G2: deferred past the grace and ended; the client was told why.
    case 'cancelled': return isDeferralEndReason(schedule.stateReason) ? status('not_included', schedule.stateReason) : { enrolled, status: null };
    // FP-6: the automatic payment succeeded, then was refunded or returned: due again.
    case 'succeeded': return status('reversed', null, { amount: invoice.balance });
    case 'not_needed': {
      // Only an enrolled client is told why this invoice is outside automatic payments.
      if (enrollment?.status !== 'active' || !schedule.ineligibleReason) return { enrolled, status: null };
      // F-8: kept manual, but no longer "over the limit you authorized" once a newer authorization covers it.
      const updated = schedule.ineligibleReason === 'above_authorized_cap' && !!method
        && await coveredByAcceptedCap(db, { orgId: invoice.orgId, enrollmentId: enrollment.id, generation: enrollment.generation, methodId: method.id },
          invoice.total, invoice.currencyCode);
      return status('not_included', updated ? 'issued_before_authorization' : schedule.ineligibleReason);
    }
    default: return { enrolled, status: null };
  }
}
