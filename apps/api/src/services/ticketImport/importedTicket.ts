import { z } from 'zod';
import { externalTicketUrlSchema, ticketTypeSchema } from '@breeze/shared';
import { MigrationWindowError } from '../migrationWindows';

/**
 * One source ticket, already converted into Breeze's model (#8313; spec
 * §4.6). A module (step 3) produces it; nothing source-shaped reaches
 * ticketService. Times are UTC instants; the module converts the source's
 * zone before building this.
 *
 * Resume semantics of the optional header fields (re-importing a ticket that
 * already exists): `undefined` leaves the stored value alone, `null` clears
 * it (categoryId, assigneeUserId). On a first import both mean "none".
 *
 * Ids: `sourceId` (the ticket) and every comment's `sourceId` must be unique
 * across the whole SOURCE, not just within one ticket. Both are resume keys
 * per import principal (ticket_external_refs, ticket_comments_import_source_uq),
 * so a module that reused per-ticket comment ids ("article 1") would see later
 * tickets' comments skipped as already imported.
 */
const CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/u;
const text = (max: number) => z.string().max(max).regex(CONTROL_CHARS, 'control characters are not allowed');
const instant = z.date().refine((d) => Number.isFinite(d.getTime()), 'invalid date');

export const IMPORTED_TICKET_SOURCES = ['email', 'portal', 'manual', 'api'] as const;
export const IMPORTED_TICKET_FINAL_STATUSES = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] as const;

const importedCommentSchema = z.object({
  sourceId: z.string().trim().min(1).max(255),
  createdAt: instant,
  isPublic: z.boolean(),
  author: z.object({
    kind: z.enum(['staff', 'requester']),
    name: text(255).trim().min(1),
    email: z.string().email().max(320).optional(),
  }).strict(),
  content: text(200_000),
}).strict();

export const importedTicketSchema = z.object({
  sourceId: z.string().trim().min(1).max(255),
  sourceNumber: z.string().trim().min(1).max(255).optional(),
  // The same rule the Partner API applies to the column (http(s), <= 2048).
  sourceUrl: externalTicketUrlSchema.optional(),
  orgId: z.string().uuid(),
  createdAt: instant,
  updatedAt: instant,
  subject: text(5_000).trim().min(1),
  description: text(200_000),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  categoryId: z.string().uuid().nullable().optional(),
  tags: z.array(text(100).trim().min(1)).max(50).optional(),
  // Main gained ticket types after the spec (#8654). Omitted: the live
  // default for the source (defaultTicketTypeForSource), with no provenance.
  ticketType: ticketTypeSchema.optional(),
  source: z.enum(IMPORTED_TICKET_SOURCES),
  requester: z.union([
    z.object({ contactId: z.string().uuid() }).strict(),
    z.object({ name: text(255).trim().min(1), email: z.string().email().max(255) }).strict(),
  ]),
  assigneeUserId: z.string().uuid().nullable().optional(),
  finalStatus: z.enum(IMPORTED_TICKET_FINAL_STATUSES),
  resolvedAt: instant.optional(),
  closedAt: instant.optional(),
  resolutionNote: text(50_000).optional(),
  comments: z.array(importedCommentSchema),
}).strict();

export type ImportedTicket = z.infer<typeof importedTicketSchema>;
export type ImportedComment = ImportedTicket['comments'][number];

function invalid(message: string, details?: Record<string, unknown>): MigrationWindowError {
  return new MigrationWindowError('MIGRATION_IMPORT_INVALID', message, 400, details);
}

/**
 * Parses and checks one ticket before anything is written (spec §4.2 "every
 * write"): every time is at or before `now` and none precedes the ticket's
 * creation; comment source ids are unique within the ticket. The service
 * re-checks each time per write; this fails the whole ticket up front
 * instead of half-way through it.
 */
export function parseImportedTicket(input: unknown, now: Date = new Date()): ImportedTicket {
  const parsed = importedTicketSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid('The imported ticket is not valid', {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const ticket = parsed.data;
  const created = ticket.createdAt.getTime();
  const nowMs = now.getTime();
  const times: Array<[string, Date | undefined]> = [
    ['createdAt', ticket.createdAt],
    ['updatedAt', ticket.updatedAt],
    ['resolvedAt', ticket.resolvedAt],
    ['closedAt', ticket.closedAt],
    ...ticket.comments.map((c, i): [string, Date] => [`comments.${i}.createdAt`, c.createdAt]),
  ];
  for (const [path, value] of times) {
    if (!value) continue;
    if (value.getTime() > nowMs) throw invalid('An imported time cannot be in the future', { path });
    if (value.getTime() < created) throw invalid('An imported time cannot precede the ticket creation', { path });
  }
  const seen = new Set<string>();
  for (const comment of ticket.comments) {
    if (seen.has(comment.sourceId)) throw invalid('Comment source ids must be unique within a ticket', { sourceId: comment.sourceId });
    seen.add(comment.sourceId);
  }
  return ticket;
}
