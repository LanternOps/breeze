import type { TicketAttachmentMime } from '../constants/ticketAttachments';

/**
 * Client-visible attachment metadata (W08 #3902). Deliberately never carries
 * storageKey, storageBackend, sha256 or data — those are server-only.
 */
export interface TicketAttachmentMeta {
  id: string;
  /** null while the upload is pending (not yet claimed by a comment). */
  commentId: string | null;
  contentType: TicketAttachmentMime;
  byteSize: number;
  originalFilename: string;
  createdAt: string;
}
