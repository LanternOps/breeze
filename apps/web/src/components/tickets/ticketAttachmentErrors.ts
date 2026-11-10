/**
 * Upload refusals that retrying can never fix: the file itself is the problem
 * (`POST /tickets/:id/attachments` answers 415 UNSUPPORTED_ATTACHMENT_TYPE,
 * 413 ATTACHMENT_TOO_LARGE, 400 EMPTY_ATTACHMENT). Everything else (network
 * status 0, 429 TOO_MANY_PENDING, 5xx, 409) is transient or about the ticket,
 * so the composer keeps its Retry chip.
 */
export type PermanentAttachmentRejection = 'type' | 'size' | 'empty';

export function permanentAttachmentRejection(
  status: number | undefined,
  code: string | undefined,
): PermanentAttachmentRejection | null {
  if (code === 'UNSUPPORTED_ATTACHMENT_TYPE' || status === 415) return 'type';
  if (code === 'ATTACHMENT_TOO_LARGE' || status === 413) return 'size';
  if (code === 'EMPTY_ATTACHMENT') return 'empty';
  return null;
}
