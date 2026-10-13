import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { getBullMQConnection } from './redis';
import { captureException } from './sentry';
import { ticketStatusEnum, ticketSourceEnum, ticketLinkTypeEnum } from '../db/schema';

// Derived locally to avoid an import cycle (ticketService imports ticketEvents).
type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];
type TicketSource = (typeof ticketSourceEnum.enumValues)[number];
type TicketLinkType = (typeof ticketLinkTypeEnum.enumValues)[number];

export const TICKET_EVENTS_QUEUE = 'ticket-events';

interface TicketEventEnvelope {
  ticketId: string;
  orgId: string;
  partnerId: string | null;
  actorUserId?: string | null;
  /**
   * The partner service principal behind the write, when the actor is one
   * (`kind: 'service_principal'`); null/absent for every other actor. Lets a
   * consumer attribute machine writes without a users row.
   */
  actorPrincipalId?: string | null;
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
  // verificationId: set when the comment is a caller-verification system
  // effect (#6354); emitted post-commit by ticketOutboxPublisher.
  | { type: 'ticket.commented'; payload: { commentId: string; isPublic: boolean; inbound?: boolean; verificationId?: string } }
  | { type: 'ticket.updated'; payload: { changed: string[] } }
  | { type: 'ticket.sla_breached'; payload: { target: 'response' | 'resolution'; internalNumber: string | null; subject: string; assigneeId: string | null } }
  // One-time autoresponse acknowledgement for an email-created ticket (spec §5).
  // Emitted by inboundEmail/autoresponder.ts (after loop-prevention) and handled by
  // ticketNotifyWorker — the single outbound code path.
  // Payload-only: ticketId/orgId/partnerId come from TicketEventEnvelope.
  | { type: 'ticket.autoresponse'; payload: { to: string; internalNumber: string | null; subject: string } }
  // Customer work approval (#4617 spec §6.4). Ids and enum labels only; the
  // notify worker (jobs/ticketApprovalNotify.ts) loads the request in system
  // context and re-validates it against the committed row, because some
  // emitters queue these inside their transaction (the portal decide route
  // queues after commit). `revision` is the request revision the emitter wrote:
  // the worker retries while the committed row is behind it and drops the
  // event once a newer revision exists. `created` = a new request (else an
  // existing pending one was re-asked or bumped at `revision`).
  | { type: 'ticket.approval_requested'; payload: { requestId: string; trigger: 'budget' | 'after_hours'; revision: number; created: boolean } }
  | { type: 'ticket.approval_decided'; payload: { requestId: string; trigger: 'budget' | 'after_hours'; status: 'approved' | 'denied' | 'expired' | 'cancelled' } }
  // Ticket-to-ticket links (#7900 W02). Emitted once for EACH of the two
  // tickets, so either ticket's consumers see the change. Ids and enum labels
  // only. `direction` is how the link reads from THIS event's ticket
  // ('outgoing': this ticket is the stored source). `reason: 'org_move'` marks
  // a link an org move deleted (emitted only for the noted tickets, after the
  // move commits). No notification fan-out today (ticketNotifyWorker no-op).
  | { type: 'ticket.link_added'; payload: { linkId: string; linkType: TicketLinkType; otherTicketId: string; direction: 'outgoing' | 'incoming' } }
  | { type: 'ticket.link_removed'; payload: { linkType: TicketLinkType; otherTicketId: string; reason: 'user' | 'org_move' } }
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

/**
 * Queue a ticket event, throwing when it cannot be queued. For a caller that
 * owns a retry of its own — ticketOutboxPublisher leaves its outbox row
 * unpublished on a throw, so the next pass queues it again (#7963).
 * Request-path emitters use emitTicketEvent instead.
 */
export async function enqueueTicketEvent(input: TicketEventInput): Promise<void> {
  const event = { ...input, eventId: input.eventId ?? randomUUID() } as TicketEvent;
  await getTicketEventsQueue().add(event.type, event, {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
    // Retry with back-off: request-path emitters (emitTicketEvent) queue while
    // the request transaction is still open, so the worker may dequeue before
    // the ticket row is visible.
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
}

// Fire-and-forget by design: a Redis outage must never fail the user-facing
// mutation that emitted the event. Consumers (notifications) are best-effort.
//
// Not for `ticket.assigned` (#7963): an emit from inside the request
// transaction can reach the worker before the assignment commits, and the
// worker reads the old assignee as "reassigned since" and drops it. That event
// is queued by ticketOutboxPublisher from the committed outbox row instead.
export async function emitTicketEvent(input: TicketEventInput): Promise<void> {
  try {
    await enqueueTicketEvent(input);
  } catch (err) {
    console.error('[TicketEvents] failed to enqueue', input.type, `ticketId=${input.ticketId}`, `orgId=${input.orgId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
