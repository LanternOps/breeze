/**
 * `ticket.status_changed` -> service-deliverable occurrence (#5573 spec §6).
 *
 * The payload is id-only by design (`{ ticketId, from, to }` — written by
 * changeTicketStatus's writeTicketOutbox, `ticketId` prepended by
 * jobs/ticketOutboxPublisher.ts), so neither the acting user nor the
 * resolution note travels on it. Both are re-read here under a system
 * context: the note from `tickets.resolution_note`, the actor from the
 * `status_change` comment changeTicketStatus writes with the real actor id in
 * the same transaction as the status change. No linked occurrence means this
 * handler does nothing at all — the overwhelming majority of tickets.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tickets, ticketComments } from '../db/schema/portal';
import { serviceDeliverableOccurrences } from '../db/schema/serviceDeliverables';
import { applyTicketStatusChange } from './serviceDeliverableService';
import type { BreezeEvent } from './eventBus';

export async function handleDeliverableTicketStatusChanged(event: BreezeEvent): Promise<void> {
  const payload = event.payload as { ticketId?: unknown; to?: unknown } | null | undefined;
  const ticketId = typeof payload?.ticketId === 'string' ? payload.ticketId : null;
  const to = typeof payload?.to === 'string' ? payload.to : null;
  const orgId = event.orgId;
  if (!ticketId || !to || !orgId) {
    // A retry cannot repair a malformed payload; drop it loudly.
    console.error('[deliverableStatusSubscriber] malformed ticket.status_changed — dropping',
      { eventId: event.id, orgId, payload: event.payload });
    return;
  }

  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const linked = await db.select({ id: serviceDeliverableOccurrences.id })
      .from(serviceDeliverableOccurrences)
      .where(and(eq(serviceDeliverableOccurrences.ticketId, ticketId), eq(serviceDeliverableOccurrences.orgId, orgId)))
      .limit(1);
    if (linked.length === 0) return;

    const [ticket] = await db.select({ resolutionNote: tickets.resolutionNote })
      .from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId))).limit(1);

    const [statusComment] = await db.select({ userId: ticketComments.userId })
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.commentType, 'status_change'), eq(ticketComments.newValue, to)))
      .orderBy(desc(ticketComments.createdAt)).limit(1);

    await applyTicketStatusChange({
      ticketId, orgId, to,
      actorUserId: statusComment?.userId ?? null,
      resolutionNote: ticket?.resolutionNote ?? null,
    });
  }, 'deliverableStatusSubscriber'));
}
