import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, integer, char, timestamp, index } from 'drizzle-orm/pg-core';
import { tickets, ticketComments } from './portal';
import { organizations } from './orgs';
import { users, bytea } from './users';

/**
 * Ticket comment attachments (W08, #3902). Shape 1 (direct org_id). Bytes are
 * either in S3 (storage_backend='s3', storage_key) or inline (storage_backend
 * ='db', data). comment_id NULL means "pending upload" (spec D2); never a
 * product concept of a ticket-level attachment.
 *
 * NEVER select `data` outside the content route — use ATTACHMENT_META_COLUMNS.
 * routes/tickets/tickets.test.ts asserts the feed query's compiled SQL.
 */
export const ticketAttachments = pgTable('ticket_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  commentId: uuid('comment_id').references(() => ticketComments.id, { onDelete: 'cascade' }),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  storageBackend: varchar('storage_backend', { length: 8 }).$type<'s3' | 'db'>().notNull(),
  storageKey: text('storage_key'),
  data: bytea('data'),
  contentType: varchar('content_type', { length: 64 }).notNull(),
  byteSize: integer('byte_size').notNull(),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  attachedAt: timestamp('attached_at', { withTimezone: true }),
}, (t) => [
  index('ticket_attachments_ticket_idx').on(t.ticketId, t.createdAt),
  // Partial indexes mirror migrations/2026-09-26-ticket-attachments.sql.
  // db:check-drift does NOT compare the Drizzle schema to the live DB, so
  // these are declared for readers, not because a check enforces them.
  index('ticket_attachments_comment_idx').on(t.commentId).where(sql`${t.commentId} IS NOT NULL`),
  index('ticket_attachments_pending_idx').on(t.uploadedByUserId, t.createdAt).where(sql`${t.commentId} IS NULL`),
  index('ticket_attachments_org_idx').on(t.orgId),
]);

export type TicketAttachmentRow = typeof ticketAttachments.$inferSelect;

/** Client-safe column subset. Everything else (data, storageKey, sha256) is server-only. */
export const ATTACHMENT_META_COLUMNS = {
  id: ticketAttachments.id,
  commentId: ticketAttachments.commentId,
  contentType: ticketAttachments.contentType,
  byteSize: ticketAttachments.byteSize,
  originalFilename: ticketAttachments.originalFilename,
  createdAt: ticketAttachments.createdAt,
} as const;
