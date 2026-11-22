/**
 * Manual payment idempotency (#3803 item 4).
 *
 * `recordPayment` serializes payment writers on the invoice row lock and checks
 * the amount against the balance recomputed under it. That stops two full-balance
 * payments from both landing, but not a retried PARTIAL payment: 40 + 40 still
 * fits a 100 balance. A caller-supplied key, unique per invoice
 * (`invoice_payments_invoice_idempotency_key_uq`), names one intended payment;
 * a retry carrying it answers with the payment already recorded.
 *
 * Only recordPayment writes keyed rows, and it holds the invoice row lock for
 * both the lookup and the insert, so the unique index is a backstop that path
 * should never trip.
 *
 * Known limit: every path that removes a payment (a manual void, a Stripe
 * reversal, an accounting-side deletion) deletes its row, and the key goes with
 * it. A retry that arrives AFTER that records the payment again. Callers retry
 * in seconds and removing a payment is a deliberate later act, so this is
 * accepted rather than keeping a tombstone table.
 */
import { and, eq } from 'drizzle-orm';
import type { RecordPaymentInput } from '@breeze/shared';
import type { db } from '../db';
import { invoicePayments } from '../db/schema';
import { toCents } from './invoiceMath';
import { InvoiceServiceError } from './invoiceTypes';

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type InvoicePaymentRow = typeof invoicePayments.$inferSelect;

/** The payment already recorded on this invoice under `key`, or null. */
export async function findPaymentByIdempotencyKey(
  dbc: DbExecutor, invoiceId: string, key: string,
): Promise<InvoicePaymentRow | null> {
  const [row] = await dbc.select().from(invoicePayments)
    .where(and(eq(invoicePayments.invoiceId, invoiceId), eq(invoicePayments.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

/**
 * A key names ONE payment: replaying it with different details is a client bug
 * (a reused key, or an edited form that kept its key), never a second payment.
 * Compared field by field, in whole cents and with an omitted optional field
 * equal to a stored NULL. The recording user is not compared: the same retry
 * may come back through another session of the same caller.
 */
export function assertSameRecordedPayment(prior: InvoicePaymentRow, input: RecordPaymentInput): void {
  const differingFields = [
    toCents(prior.amount) !== toCents(input.amount) && 'amount',
    prior.method !== input.method && 'method',
    prior.receivedAt !== input.receivedAt && 'receivedAt',
    (prior.reference ?? null) !== (input.reference ?? null) && 'reference',
    (prior.note ?? null) !== (input.note ?? null) && 'note',
  ].filter((f): f is string => f !== false);
  if (differingFields.length > 0) {
    throw new InvoiceServiceError(
      'This idempotency key was already used for a different payment on this invoice. Use a new key for a new payment.',
      409,
      'IDEMPOTENCY_KEY_REUSED',
      { differingFields },
    );
  }
}
