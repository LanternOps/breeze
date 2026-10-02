import { eq, inArray, sql } from 'drizzle-orm';
import { RESERVING_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { invoices, invoicePayments, invoiceCollectionAttempts } from '../../db/schema';
import { InvoiceServiceError } from '../invoiceTypes';
import type { Tx } from './types';

export interface LockedInvoiceForCollection {
  invoice: typeof invoices.$inferSelect;
  reservedAmount: string;
  unreservedBalance: string;
}
function hundredths(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new InvoiceServiceError('Invalid payment amount', 400, 'INVALID_AMOUNT');
  const magnitude = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -magnitude : magnitude;
}
/** All collection producers serialize on this row. Reservation creators must
 * also call assertInvoiceSessionsRevoked after this lock and before inserting
 * an attempt: a pre-lock revocation pass cannot exclude Checkout publication.
 */
export async function lockInvoiceForCollection(tx: Tx, invoiceId: string): Promise<LockedInvoiceForCollection> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  const reserved = sql`coalesce((select sum(${invoiceCollectionAttempts.principalAmount}) from ${invoiceCollectionAttempts}
    where ${invoiceCollectionAttempts.invoiceId} = ${invoiceId}
    and ${inArray(invoiceCollectionAttempts.state, [...RESERVING_COLLECTION_ATTEMPT_STATES])}), 0)`;
  const balance = sql`${invoice.total}::numeric - coalesce((select sum(${invoicePayments.amount}) from ${invoicePayments}
    where ${invoicePayments.invoiceId} = ${invoiceId}), 0)`;
  const [amounts] = await tx.select({
    reservedAmount: sql<string>`(${reserved})::numeric(12,2)::text`,
    balance: sql<string>`(${balance})::numeric(12,2)::text`,
    unreservedBalance: sql<string>`greatest(0, (${balance}) - (${reserved}))::numeric(12,2)::text`,
  }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!amounts) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  return { invoice: { ...invoice, balance: amounts.balance }, reservedAmount: amounts.reservedAmount, unreservedBalance: amounts.unreservedBalance };
}
/** Lock-free read of "is an autopay/collection attempt in flight?" for customer
 * views (#7824). Uses the same reserving-state set as the 409 gate
 * (`assertNoActiveCollection`), so the UI state and the server refusal cannot
 * diverge. Advisory only: it takes no lock, the pay routes still enforce.
 */
export async function readInFlightCollection(tx: Tx, invoiceId: string): Promise<{ inProgress: boolean; amount: string }> {
  const [row] = await tx.select({
    reservedAmount: sql<string>`coalesce(sum(${invoiceCollectionAttempts.principalAmount}), 0)::numeric(12,2)::text`,
  }).from(invoiceCollectionAttempts)
    .where(sql`${invoiceCollectionAttempts.invoiceId} = ${invoiceId}
      and ${inArray(invoiceCollectionAttempts.state, [...RESERVING_COLLECTION_ATTEMPT_STATES])}`)
    .limit(1);
  const amount = row?.reservedAmount ?? '0.00';
  return { inProgress: hundredths(amount) > 0n, amount };
}
export async function assertNoActiveCollection(tx: Tx, invoiceId: string): Promise<void> {
  const locked = await lockInvoiceForCollection(tx, invoiceId);
  if (hundredths(locked.reservedAmount) > 0n) {
    throw new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS');
  }
}
export async function assertCollectionAmountAvailable(tx: Tx, invoiceId: string, amount: string, replacingPaymentId?: string): Promise<void> {
  const locked = await lockInvoiceForCollection(tx, invoiceId);
  let previous = 0n;
  if (replacingPaymentId) {
    const [payment] = await tx.select({ amount: invoicePayments.amount }).from(invoicePayments)
      .where(sql`${invoicePayments.id} = ${replacingPaymentId} and ${invoicePayments.invoiceId} = ${invoiceId}`).limit(1);
    if (!payment) throw new InvoiceServiceError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    previous = hundredths(payment.amount);
  }
  const requested = hundredths(amount);
  if (requested < 0n) throw new InvoiceServiceError('Invalid payment amount', 400, 'INVALID_AMOUNT');
  if (requested - previous <= hundredths(locked.unreservedBalance)) return;
  if (hundredths(locked.reservedAmount) > 0n) {
    throw new InvoiceServiceError('Payment exceeds the balance available while another payment is processing', 409, 'COLLECTION_IN_PROGRESS');
  }
  throw new InvoiceServiceError('Payment exceeds balance', 400, 'OVERPAYMENT');
}
