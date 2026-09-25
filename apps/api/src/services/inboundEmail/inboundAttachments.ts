import { TICKET_ATTACHMENT_LIMITS } from '@breeze/shared';
import { db } from '../../db';
import { ticketAttachments } from '../../db/schema/ticketAttachments';
import type { InboundAttachmentSkipReason, NormalizedInboundEmail } from './types';

/**
 * Inbound-email attachment persistence (#6688). Provider-agnostic: the bytes
 * were already written to attachment storage OUTSIDE the pipeline transaction
 * (see ticketMailbox/fetchInboundAttachments.ts); this only inserts the rows,
 * inside it, so a rollback discards them with the ticket/comment.
 */

const MAX_NAMED_IN_NOTE = 10;

const REASON_TEXT: Record<InboundAttachmentSkipReason, string> = {
  too_large: `over the ${Math.round(TICKET_ATTACHMENT_LIMITS.maxBytes / (1024 * 1024))} MB limit`,
  unsupported_type: 'file type not supported',
  too_many: `more than ${TICKET_ATTACHMENT_LIMITS.maxPerComment} attachments`,
  fetch_failed: 'could not be retrieved',
  storage_failed: 'could not be stored',
  provider_unsupported: 'attachment import is not available for this mailbox yet',
};

export function hasStoredAttachments(n: NormalizedInboundEmail): boolean {
  return n.attachments.some((a) => a.stored);
}

/**
 * One line naming each attachment that was NOT imported and why, or null when
 * nothing was skipped. Appended to the ticket description / inbound comment so
 * a dropped file is visible to the technician instead of silently missing.
 */
export function inboundAttachmentNote(n: NormalizedInboundEmail): string | null {
  const skipped = n.attachments.filter((a) => a.skipReason);
  if (skipped.length === 0) return null;
  // A whole-message retrieval failure carries no filename.
  if (skipped.every((a) => !a.filename)) {
    return '[Email attachments could not be retrieved from the mailbox.]';
  }
  const named = skipped
    .filter((a) => a.filename)
    .slice(0, MAX_NAMED_IN_NOTE)
    .map((a) => `${a.filename} (${REASON_TEXT[a.skipReason!]})`);
  const more = skipped.length - named.length;
  return `[Email attachments not imported: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}]`;
}

/** `text` with the skip note appended on its own line (unchanged when there is none). */
export function withInboundAttachmentNote(text: string, n: NormalizedInboundEmail): string {
  const note = inboundAttachmentNote(n);
  if (!note) return text;
  return text ? `${text}\n\n${note}` : note;
}

/**
 * Insert an ATTACHED `ticket_attachments` row for every stored attachment,
 * on `commentId` (a comment-less row is a pending upload the reaper deletes
 * after 24h and nobody but its uploader can read). `uploaded_by_user_id` is
 * NULL: an email sender is not a Breeze user. Marks each row `persisted` so the
 * worker's orphan cleanup leaves its blob alone. Returns the row count.
 */
export async function persistInboundAttachments(
  n: NormalizedInboundEmail,
  target: { ticketId: string; orgId: string; commentId: string },
): Promise<number> {
  const toInsert = n.attachments.filter((a) => a.stored && !a.persisted);
  if (toInsert.length === 0) return 0;
  const attachedAt = new Date();
  await db.insert(ticketAttachments).values(toInsert.map((a) => ({
    id: a.stored!.attachmentId,
    orgId: target.orgId,
    ticketId: target.ticketId,
    commentId: target.commentId,
    uploadedByUserId: null,
    storageBackend: a.stored!.storageBackend,
    storageKey: a.stored!.storageKey,
    data: a.stored!.data,
    contentType: a.stored!.contentType,
    byteSize: a.stored!.byteSize,
    originalFilename: a.filename,
    sha256: a.stored!.sha256,
    attachedAt,
  })));
  for (const a of toInsert) a.persisted = true;
  return toInsert.length;
}
