import { and, eq } from 'drizzle-orm';
import { autopayTermsSnapshotSchema, formatPaymentMethod, type CustomerInvoiceAutopayStatus } from '@breeze/shared';
import { invoices, invoiceAutopaySchedules, orgAutopayEnrollments } from '../../db/schema';
import { readInFlightCollection } from './reservation';
import { getAutopayMethod } from './paymentMethods';
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
  if (!schedule) return { enrolled, status: null };

  const parsed = autopayTermsSnapshotSchema.safeParse(schedule.termsSnapshot);
  const terms = parsed.success && parsed.data.kind === 'terms' ? parsed.data : null;
  const inFlight = await readInFlightCollection(db, invoice.id);
  const base: Omit<CustomerInvoiceAutopayStatus, 'state' | 'reason'> = {
    chargeDate: schedule.collectOn ?? null,
    amount: terms?.principal ?? null, fee: terms?.feeAmount ?? null, currency: invoice.currencyCode,
    methodLabel: terms ? (method && method.id === terms.methodId ? formatPaymentMethod(method)
      : formatPaymentMethod({ type: terms.methodType, cardLast4: terms.last4, bankLast4: terms.last4 })) : null,
    methodType: terms?.methodType ?? null,
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    canPayNow: !inFlight.inProgress,
  };
  const status = (state: CustomerInvoiceAutopayStatus['state'], reason: string | null = null, over: Partial<CustomerInvoiceAutopayStatus> = {}) =>
    ({ enrolled, status: { ...base, state, reason, ...over } });

  if (inFlight.inProgress) {
    return status(inFlight.actionRequired ? 'action_required' : 'processing', null, { amount: inFlight.amount });
  }
  if (schedule.state === 'succeeded' && invoice.status === 'paid') return status('paid_automatically');
  if (!OPEN.has(invoice.status)) return { enrolled, status: null };
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
    case 'not_needed':
      // Only an enrolled client is told why this invoice is outside automatic payments.
      return enrollment?.status === 'active' && schedule.ineligibleReason
        ? status('not_included', schedule.ineligibleReason) : { enrolled, status: null };
    default: return { enrolled, status: null };
  }
}
