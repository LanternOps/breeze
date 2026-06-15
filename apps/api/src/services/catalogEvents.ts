import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

export const CATALOG_EVENTS_QUEUE = 'catalog-events';

interface CatalogEventEnvelope {
  catalogItemId: string;
  partnerId: string;
  actorUserId?: string | null;
}

export type CatalogEvent = CatalogEventEnvelope & {
  type: 'catalog.item.created' | 'catalog.item.updated' | 'catalog.item.archived';
};

let queue: Queue | null = null;

export function getCatalogEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(CATALOG_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design (timeEntryEvents.ts pattern): a Redis outage must
// never fail the user-facing mutation that emitted the event.
export async function emitCatalogEvent(event: CatalogEvent): Promise<void> {
  try {
    await getCatalogEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[CatalogEvents] failed to enqueue', event.type, `catalogItemId=${event.catalogItemId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
