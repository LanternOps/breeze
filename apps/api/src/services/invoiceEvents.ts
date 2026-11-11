import { Queue } from 'bullmq';
import { runAfterDbContextCommit } from '../db';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

// `invoice-events` is an intentionally-unconsumed RESERVED bus (same pattern as
// `catalog-events` / `time-entry-events`): emitInvoiceEvent publishes lifecycle
// events but nothing reads them yet. Future webhook / notification delivery wires
// a Worker against this queue. Until then, jobs simply expire per the
// removeOnComplete/removeOnFail retention below — there is no delivery today.
export const INVOICE_EVENTS_QUEUE = 'invoice-events';

export type InvoiceEvent =
  | {
      type: 'invoice.issued' | 'invoice.sent' | 'invoice.viewed' | 'invoice.overdue' | 'invoice.paid' | 'invoice.voided';
      invoiceId: string;
      orgId: string;
      partnerId: string;
      /** Null for system/background actors (e.g. contract worker). */
      actorUserId?: string | null;
    }
  | {
      type: 'payment.recorded' | 'payment.voided';
      invoiceId: string;
      orgId: string;
      partnerId: string;
      paymentId: string;
      /** Null for system/background actors (e.g. contract worker). */
      actorUserId?: string | null;
    }
  | {
      // payment.failed can fire BEFORE any invoice_payments row exists (a Stripe
      // charge that we terminally reject pre-write), so paymentId is optional —
      // the event still carries the real invoice/org/partner context.
      type: 'payment.failed';
      invoiceId: string;
      orgId: string;
      partnerId: string;
      paymentId?: string;
      actorUserId?: string | null;
    };

let queue: Queue | null = null;

function getInvoiceEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(INVOICE_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

/**
 * Publish an invoice lifecycle event once the caller's transaction COMMITS
 * (#3803 item 9). The enqueue is registered with runAfterDbContextCommit:
 *
 * - On the request path recordPayment / voidPayment run inside the request-wide
 *   transaction and hold the invoice row lock until it commits. Enqueueing
 *   inline kept that lock (and the pooled connection) waiting on Redis;
 *   deferred, the transaction ends first. Emitters whose own top-level
 *   transaction has already committed (issue, overdue sweep) wait only for any
 *   enclosing request context to end.
 * - A rolled-back transaction publishes nothing, so no subscriber is told about
 *   a payment, void or issue that never happened.
 * - With no DB context held (e.g. recordStripePayment after its own system
 *   transaction returned) the enqueue starts immediately.
 *
 * The returned promise resolves once the event is scheduled, not delivered.
 * Register only after the change is final: work registered inside a savepoint
 * that rolls back still runs if the outer transaction commits.
 *
 * Fire-and-forget by design (catalogEvents.ts / timeEntryEvents.ts pattern): a
 * Redis outage must never fail the user-facing mutation that emitted the event.
 */
export function emitInvoiceEvent(event: InvoiceEvent): Promise<void> {
  runAfterDbContextCommit(`invoice-events: ${event.type} invoiceId=${event.invoiceId}`, () => enqueueInvoiceEvent(event));
  return Promise.resolve();
}

async function enqueueInvoiceEvent(event: InvoiceEvent): Promise<void> {
  try {
    await getInvoiceEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[InvoiceEvents] failed to enqueue', event.type, `invoiceId=${event.invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
