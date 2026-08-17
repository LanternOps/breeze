import { db } from '../../db';
import { ticketComments } from '../../db/schema';
import { emitTicketEvent } from '../ticketEvents';

export interface EmailCommentInput {
  ticketId: string;
  orgId: string; // for the emitted event; inbound pipeline passes '' today (existing wart, preserved)
  senderPortalUserId?: string | null;
  authorName: string; // stored portal-user name preferred over spoofable display name — caller resolves
  content: string;
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
  const { ticketId, orgId, senderPortalUserId, authorName, content } = input;

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

  return { commentId: comment.id };
}
