import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

// `quote-events` is an intentionally-unconsumed RESERVED bus (same pattern as
// `invoice-events` / `catalog-events`): emitQuoteEvent publishes lifecycle
// events but nothing reads them yet. Future webhook / notification delivery
// ("your customer just opened the proposal") wires a Worker against this
// queue. Until then, jobs simply expire per the retention below.
export const QUOTE_EVENTS_QUEUE = 'quote-events';

export interface QuoteEvent {
  type: 'quote.viewed';
  quoteId: string;
  orgId: string;
  partnerId: string;
}

let queue: Queue | null = null;

function getQuoteEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUOTE_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design (invoiceEvents.ts pattern): a Redis outage must
// never fail the customer-facing view that emitted the event.
export async function emitQuoteEvent(event: QuoteEvent): Promise<void> {
  try {
    await getQuoteEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch (err) {
    console.error('[QuoteEvents] failed to enqueue', event.type, `quoteId=${event.quoteId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
