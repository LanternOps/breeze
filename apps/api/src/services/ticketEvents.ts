import { randomUUID } from 'crypto';
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
  /**
   * W07 (#3901): unique per emitted event; the notify worker uses it in the
   * user_notifications dedupe key so a BullMQ retry never re-pushes while a
   * genuine A->B->A reassignment does. Stamped by emitTicketEvent — emitters
   * never set it. Jobs queued before this shipped lack it; the worker falls
   * back to job.id.
   */
  eventId: string;
}

export type TicketEvent = TicketEventEnvelope & (
  // #3828 wave-6-3 task 2: subject dropped from the payload — the notify
  // worker's ticket.created/ticket.assigned branch (collectAssigneeNotification)
  // already fetches ticket.subject from the DB and never read the payload field.
  | { type: 'ticket.created'; payload: { internalNumber: string; assigneeId: string | null; source: TicketSource } }
  // #3828 wave-6-3 task 2: resolutionNote dropped from the payload (it is
  // free-text ticket content, same reasoning as `subject` above) — the notify
  // worker's resolved-email branch now reads it from the ticket row instead.
  | { type: 'ticket.status_changed'; payload: { from: TicketStatus; to: TicketStatus } }
  | { type: 'ticket.assigned'; payload: { assigneeId: string | null } }
  // `inbound` marks a comment that originated from an inbound customer email. The
  // notify worker's ticket.commented branch skips the requester echo when
  // event.payload.inbound is set (guard: `isPublic && !inbound`), so the email is
  // never bounced back to the same sender — preventing a mail loop.
  | { type: 'ticket.commented'; payload: { commentId: string; isPublic: boolean; inbound?: boolean } }
  | { type: 'ticket.updated'; payload: { changed: string[] } }
  | { type: 'ticket.sla_breached'; payload: { target: 'response' | 'resolution'; internalNumber: string | null; subject: string; assigneeId: string | null } }
  // One-time autoresponse acknowledgement for an email-created ticket (spec §5).
  // Emitted by inboundEmail/autoresponder.ts (after loop-prevention + the per-sender
  // Redis cap) and handled by ticketNotifyWorker — the single outbound code path.
  // Payload-only: ticketId/orgId/partnerId come from TicketEventEnvelope.
  | { type: 'ticket.autoresponse'; payload: { to: string; internalNumber: string | null; subject: string } }
);

export type TicketEventType = TicketEvent['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What emitters pass: eventId is optional and normally omitted. */
export type TicketEventInput = DistributiveOmit<TicketEvent, 'eventId'> & { eventId?: string };

let queue: Queue | null = null;

export function getTicketEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(TICKET_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design: a Redis outage must never fail the user-facing
// mutation that emitted the event. Consumers (notifications) are best-effort.
export async function emitTicketEvent(input: TicketEventInput): Promise<void> {
  const event = { ...input, eventId: input.eventId ?? randomUUID() } as TicketEvent;
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
