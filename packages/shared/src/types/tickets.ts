/**
 * Client-visible attachment metadata (W08 #3902). Deliberately never carries
 * storageKey, storageBackend, sha256 or data — those are server-only.
 */
export interface TicketAttachmentMeta {
  id: string;
  /** null while the upload is pending (not yet claimed by a comment). */
  commentId: string | null;
  /**
   * The STORED type: one of TICKET_ATTACHMENT_LIMITS.allowedMimes for a live
   * upload, and also `application/octet-stream` for an imported file outside
   * that allowlist (#8313 W1, spec 2026-10-19 §4.4), which is served
   * download-only. Render inline only `image/*`.
   */
  contentType: string;
  byteSize: number;
  originalFilename: string;
  createdAt: string;
}
