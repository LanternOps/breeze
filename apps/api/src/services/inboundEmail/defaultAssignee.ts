import { assignTicket, TicketServiceError, type TicketActor } from '../ticketService';

/**
 * Default assignee for tickets created by the inbound pipeline
 * (settings.ticketing.inbound.defaultAssigneeUserId).
 *
 * Two checks, at two different times:
 *  - SAVE (PATCH /orgs/partners/me): isAssignableInboundDefaultUser
 *    (defaultAssigneeEligibility.ts, kept apart so the route does not import
 *    ticketService). The user must be an active member of THIS partner
 *    (users.partner_id and a partner_users row in it, org access not 'none')
 *    whose partner role grants tickets:read, the permission every ticket
 *    assignment requires.
 *  - INGEST (applyDefaultInboundAssignee): assignTicket's own per-ticket
 *    eligibility check (same partner, active, tickets:read, access to the
 *    ticket's org). A user who passed at save but no longer qualifies, or cannot
 *    open this ticket's org, leaves the ticket unassigned; ingestion never fails
 *    because of this setting.
 */

/** ticketService refusal codes that mean "this user cannot own this ticket". */
const INELIGIBLE_CODES = new Set(['ASSIGNEE_NOT_FOUND', 'ASSIGNEE_WRONG_PARTNER', 'ASSIGNEE_NOT_ELIGIBLE']);

export type DefaultAssigneeOutcome =
  | { kind: 'not_configured' }
  | { kind: 'already_assigned' }
  | { kind: 'assigned'; assigneeId: string }
  | { kind: 'skipped'; code: string };

/**
 * Assign a ticket the inbound pipeline just created to the partner's default
 * assignee, in the pipeline's own transaction.
 *
 * Runs only when no other assignment applied: a ticket that already has an
 * assignee is left alone. Goes through assignTicket, so the assignment's feed
 * comment and `ticket.assigned` outbox row commit or roll back with the ticket.
 * Since #8040 the `ticket.assigned` job is queued by ticketOutboxPublisher from
 * that committed row, so the assignee notification cannot run before the
 * ticket and its assignee are visible, and a rolled-back ingest queues nothing.
 *
 * Not transactional: the `ticket.assign` audit row. assignTicket writes it with
 * createAuditLogAsync, which commits on its own connection, so it survives an
 * ingest that rolls back after this step, exactly as createTicket's
 * `ticket.create` audit row for the same ingest already does.
 *
 * An eligibility refusal returns 'skipped' (the ticket stays unassigned and the
 * caller records the code in the inbound log). Anything else propagates.
 */
export async function applyDefaultInboundAssignee(
  ticket: { id: string; assignedTo: string | null },
  defaultAssigneeUserId: string | null,
  actor: TicketActor,
): Promise<DefaultAssigneeOutcome> {
  if (!defaultAssigneeUserId) return { kind: 'not_configured' };
  if (ticket.assignedTo) return { kind: 'already_assigned' };
  try {
    await assignTicket(ticket.id, defaultAssigneeUserId, actor);
    return { kind: 'assigned', assigneeId: defaultAssigneeUserId };
  } catch (err) {
    if (err instanceof TicketServiceError && err.code && INELIGIBLE_CODES.has(err.code)) {
      return { kind: 'skipped', code: err.code };
    }
    throw err;
  }
}
