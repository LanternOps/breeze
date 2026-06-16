import { Queue } from 'bullmq';
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

// Fire-and-forget by design (catalogEvents.ts / timeEntryEvents.ts pattern): a
// Redis outage must never fail the user-facing mutation that emitted the event.
export async function emitInvoiceEvent(event: InvoiceEvent): Promise<void> {
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
