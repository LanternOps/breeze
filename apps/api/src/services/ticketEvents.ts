import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';

export const TICKET_EVENTS_QUEUE = 'ticket-events';

export type TicketEventType =
  | 'ticket.created'
  | 'ticket.status_changed'
  | 'ticket.assigned'
  | 'ticket.commented';

export interface TicketEvent {
  type: TicketEventType;
  ticketId: string;
  orgId: string;
  partnerId: string | null;
  actorUserId?: string | null;
  payload: Record<string, unknown>;
}

let queue: Queue | null = null;

export function getTicketEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(TICKET_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design: a Redis outage must never fail the user-facing
// mutation that emitted the event. Consumers (notifications) are best-effort.
export async function emitTicketEvent(event: TicketEvent): Promise<void> {
  try {
    await getTicketEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      // Retry with back-off: the service emits events while the request transaction
      // is still open, so the worker may dequeue before the ticket row is visible.
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[TicketEvents] failed to enqueue', event.type, `ticketId=${event.ticketId}`, `orgId=${event.orgId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
