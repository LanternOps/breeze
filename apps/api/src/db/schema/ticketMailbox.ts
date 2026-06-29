import { pgTable, uuid, text, varchar, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

export const ticketMailboxConnections = pgTable('ticket_mailbox_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  tenantId: text('tenant_id'),
  mailboxAddress: text('mailbox_address').notNull(),
  displayName: text('display_name'),
  status: varchar('status', { length: 20 }).notNull().default('pending_consent'),
  deltaLink: text('delta_link'),
  strictSenderAuth: boolean('strict_sender_auth').notNull().default(false),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerMailboxIdx: uniqueIndex('ticket_mailbox_connections_partner_mailbox_idx')
    .on(table.partnerId, table.mailboxAddress),
  idPartnerIdx: uniqueIndex('ticket_mailbox_connections_id_partner_idx')
    .on(table.id, table.partnerId),
}));
