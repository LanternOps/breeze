/**
 * Wisp specialists (W07, feature #9906) — Zod for specialist-kind params.
 *
 * `bulkTicketReplyParamsSchema` (w00 A30): the pinned batch reply. The approval
 * card shows exactly these ticket ids and this message; the intent digest pins
 * sha256(sorted ticketIds + message), and the executor
 * (`apps/api/src/services/wisp/specialists/bulkTicketReply.ts`) re-parses the
 * stored params with this schema and refuses on a digest mismatch. Ticket ids
 * are unique so the card's count and the sent count can never disagree.
 */
import { z } from 'zod';

export const BULK_TICKET_REPLY_MAX_TICKETS = 250;
export const BULK_TICKET_REPLY_MESSAGE_MAX = 4000;
export const BULK_TICKET_REPLY_NOTE_MAX = 1000;

export const bulkTicketReplyParamsSchema = z.strictObject({
  concernId: z.uuid().nullable(),
  ticketIds: z
    .array(z.uuid())
    .min(1)
    .max(BULK_TICKET_REPLY_MAX_TICKETS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'ticketIds must be unique' }),
  message: z.string().min(1).max(BULK_TICKET_REPLY_MESSAGE_MAX),
  holdTickets: z.boolean().default(false),
  internalNote: z.string().max(BULK_TICKET_REPLY_NOTE_MAX).optional(),
});

export type BulkTicketReplyParams = z.infer<typeof bulkTicketReplyParamsSchema>;
