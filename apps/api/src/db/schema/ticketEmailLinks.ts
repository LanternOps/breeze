import { pgTable, uuid, text, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tickets, ticketComments } from './portal';
import { organizations, partners } from './orgs';
import { users } from './users';

// Cross-channel email↔ticket association + idempotency ledger (spec §4).
// Tenancy: shape 1 (direct org_id, auto-discovered RLS). partner_id is
// denormalized ONLY for the (partner_id, message_id) idempotency claim —
// it is NOT an access axis; keep this table out of DUAL_AXIS_TENANT_TABLES.
export const ticketEmailLinks = pgTable('ticket_email_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  messageId: text('message_id').notNull(), // normalized RFC 5322 Message-ID, angle brackets included
  commentId: uuid('comment_id').references(() => ticketComments.id, { onDelete: 'set null' }),
  origin: varchar('origin', { length: 20 }).notNull(), // 'addin_link' | 'addin_create' | 'inbound' (extensible: 'backfill')
  visibility: varchar('visibility', { length: 10 }).notNull(), // 'public' | 'internal'
  linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }), // null for pipeline-origin rows
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ticket_email_links_partner_message_uq').on(t.partnerId, t.messageId),
  index('ticket_email_links_ticket_idx').on(t.ticketId),
]);
