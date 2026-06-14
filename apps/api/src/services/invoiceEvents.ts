import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

export const INVOICE_EVENTS_QUEUE = 'invoice-events';

export type InvoiceEvent =
  | {
      type: 'invoice.issued' | 'invoice.sent' | 'invoice.viewed' | 'invoice.overdue' | 'invoice.paid' | 'invoice.voided';
      invoiceId: string;
      orgId: string;
      partnerId: string;
      actorUserId?: string;
    }
  | {
      type: 'payment.recorded' | 'payment.voided';
      invoiceId: string;
      orgId: string;
      partnerId: string;
      paymentId: string;
      actorUserId?: string;
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
