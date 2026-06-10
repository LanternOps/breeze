import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';
import { ticketStatusEnum, ticketSourceEnum } from '../db/schema';

// Derived locally to avoid an import cycle (ticketService imports ticketEvents).
type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];
type TicketSource = (typeof ticketSourceEnum.enumValues)[number];

export const TICKET_EVENTS_QUEUE = 'ticket-events';

interface TicketEventEnvelope {
  ticketId: string;
  orgId: string;
  partnerId: string | null;
  actorUserId?: string | null;
}

export type TicketEvent = TicketEventEnvelope & (
  | { type: 'ticket.created'; payload: { internalNumber: string; subject: string; assigneeId: string | null; source: TicketSource } }
  | { type: 'ticket.status_changed'; payload: { from: TicketStatus; to: TicketStatus; resolutionNote: string | null } }
  | { type: 'ticket.assigned'; payload: { assigneeId: string | null } }
  | { type: 'ticket.commented'; payload: { commentId: string; isPublic: boolean } }
);

export type TicketEventType = TicketEvent['type'];

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
