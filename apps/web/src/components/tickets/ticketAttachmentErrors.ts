/**
 * Upload refusals that retrying can never fix, so the composer drops the chip
 * and says why instead of offering a Retry:
 *  - the file itself is the problem (`POST /tickets/:id/attachments` answers
 *    415 UNSUPPORTED_ATTACHMENT_TYPE, 413 ATTACHMENT_TOO_LARGE, 400
 *    EMPTY_ATTACHMENT);
 *  - the ticket cannot take attachments any more (409 TICKET_DELETED, 409
 *    TICKET_MERGED, 404);
 *  - the request itself is malformed (400 INVALID_MULTIPART).
 * Everything else (network status 0, 429 TOO_MANY_PENDING, 5xx) is transient,
 * so the composer keeps its Retry chip.
 */
export type PermanentAttachmentRejection =
  | 'type'
  | 'size'
  | 'empty'
  | 'ticketDeleted'
  | 'ticketMerged'
  | 'notFound'
  | 'malformed';

export function permanentAttachmentRejection(
  status: number | undefined,
  code: string | undefined,
): PermanentAttachmentRejection | null {
  if (code === 'UNSUPPORTED_ATTACHMENT_TYPE' || status === 415) return 'type';
  if (code === 'ATTACHMENT_TOO_LARGE' || status === 413) return 'size';
  if (code === 'EMPTY_ATTACHMENT') return 'empty';
  if (code === 'TICKET_DELETED') return 'ticketDeleted';
  if (code === 'TICKET_MERGED') return 'ticketMerged';
  if (code === 'INVALID_MULTIPART') return 'malformed';
  if (status === 404) return 'notFound';
  return null;
}

/** The surviving ticket id a 409 TICKET_MERGED carries in `details`, if any. */
export function mergedIntoTicketId(body: unknown): string | null {
  const details = (body as { details?: { mergedIntoTicketId?: unknown } } | null | undefined)?.details;
  const id = details?.mergedIntoTicketId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
