/**
 * Ticket comment attachment limits (W08 #3902, spec D5). Single source of truth
 * for the API's post-parse check, the web composer's pre-flight and the mobile
 * client's size pre-check. Raising maxBytes needs a migration too — the
 * ticket_attachments_size_chk CHECK constraint mirrors it.
 */
export const TICKET_ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPerComment: 5,
  maxPendingPerUser: 20,
  allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
} as const;

export type TicketAttachmentMime = (typeof TICKET_ATTACHMENT_LIMITS.allowedMimes)[number];
