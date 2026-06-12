import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

export const TIME_ENTRY_EVENTS_QUEUE = 'time-entry-events';

interface TimeEntryEventEnvelope {
  timeEntryId: string;
  partnerId: string;
  ticketId: string | null;
  actorUserId?: string | null;
}

export type TimeEntryEvent = TimeEntryEventEnvelope & (
  | { type: 'time_entry.created'; payload: { userId: string; durationMinutes: number | null; isBillable: boolean } }
  | { type: 'time_entry.updated'; payload: { changed: string[] } }
  | { type: 'time_entry.deleted'; payload: { userId: string } }
  | { type: 'time_entry.approved'; payload: { ids: string[]; approvedBy: string } }
);

let queue: Queue | null = null;

export function getTimeEntryEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(TIME_ENTRY_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design (ticketEvents.ts pattern): a Redis outage must
// never fail the user-facing mutation that emitted the event.
export async function emitTimeEntryEvent(event: TimeEntryEvent): Promise<void> {
  try {
    await getTimeEntryEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[TimeEntryEvents] failed to enqueue', event.type, `timeEntryId=${event.timeEntryId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
