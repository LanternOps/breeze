import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { ticketComments, tickets } from '../../db/schema';
import { emitTicketEvent } from '../ticketEvents';
import { writeTicketCommentedOutbox } from '../ticketService';

export interface EmailCommentInput {
  ticketId: string;
  orgId: string; // for the emitted event; inbound pipeline passes '' today (existing wart, preserved)
  senderPortalUserId?: string | null;
  authorName: string; // stored portal-user name preferred over spoofable display name — caller resolves
  content: string;
  /**
   * Default true. False only for a comment written in the same pipeline step
   * that already emitted `ticket.created` (the carrier comment for a new
   * ticket's email attachments, #6688) — a second event would re-notify, and
   * a second outbox row would announce the carrier note as a reply.
   */
  emitEvent?: boolean;
}

// Shared email-authored comment semantics. Inserted directly (NOT via addTicketComment,
// which forces authorType:'internal' / user_id=actor). Precondition per caller: either
// system scope (inbound pipeline — breeze_user_isolation_insert's user_id-NULL branch),
// or partner scope where the email-authored INSERT policy applies
// (breeze_ticket_parent_email_insert, 2026-08-23 — user_id NULL + author_type 'email'
// on an org-accessible ticket; a resolved sender's portal_user_id path is also covered
// by breeze_ticket_parent_portal_insert). Email-sourced comments are ALWAYS public
// (spec §4: email can never create an internal note).
export async function insertEmailAuthoredComment(input: EmailCommentInput): Promise<{ commentId: string }> {
  const { ticketId, orgId, senderPortalUserId, authorName, content, emitEvent = true } = input;

  const inserted = await db.insert(ticketComments).values({
    ticketId,
    userId: null,
    portalUserId: senderPortalUserId ?? null,
    authorName,
    authorType: 'email',
    commentType: 'comment',
    content,
    isPublic: true,
    oldValue: null,
    newValue: null
  }).returning();
  const comment = inserted[0];
  if (!comment) throw new Error('failed to insert inbound comment');
  if (!emitEvent) return { commentId: comment.id };

  // inbound:true -> the notify worker's ticket.commented branch skips the requester
  // echo when event.payload.inbound is set (its guard is `isPublic && !inbound`), so the
  // email is never bounced back to the same sender — preventing a mail loop.
  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId,
    orgId,
    partnerId: null,
    actorUserId: null,
    payload: { commentId: comment.id, isPublic: true, inbound: true }
  });

  // #8326 — the `ticket.commented` outbox row every other comment writer leaves,
  // so webhooks and automations see a customer's emailed reply (and a public
  // email linked from the Outlook add-in) like any other comment. It runs on the
  // ambient `db`, so it commits or rolls back with the comment — and with the
  // reopen's `ticket.status_changed` row, which the inbound pipeline writes in
  // the same transaction. The org comes from the ticket row, not `orgId`, which
  // the inbound pipeline passes as ''. The origin is the stored row's (`user`,
  // no principal), the same value the Partner API feed returns for it.
  const [ticket] = await db
    .select({ orgId: tickets.orgId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) throw new Error('failed to resolve the ticket of an inbound comment');
  await writeTicketCommentedOutbox({
    orgId: ticket.orgId,
    ticketId,
    commentId: comment.id,
    isPublic: true,
    originPrincipalKind: comment.originPrincipalKind,
    originPrincipalId: comment.originPrincipalId,
  });

  return { commentId: comment.id };
}
