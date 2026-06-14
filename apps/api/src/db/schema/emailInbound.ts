import { pgTable, uuid, text, varchar, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { tickets } from './portal';

// Shape 3 (partner-axis). Audit trail + dead-letter/review queue for inbound mail.
// partner_id is nullable: rows whose recipient resolves to no partner are logged
// with parse_status='ignored' and a null partner_id (system-scope writes only).
export const ticketEmailInbound = pgTable('ticket_email_inbound', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').references(() => partners.id),
  provider: varchar('provider', { length: 50 }).notNull(),
  providerMessageId: text('provider_message_id').notNull(),
  fromAddress: text('from_address'),
  toAddress: text('to_address'),
  subject: text('subject'),
  messageId: text('message_id'),
  inReplyTo: text('in_reply_to'),
  references: text('references'),
  parseStatus: varchar('parse_status', { length: 20 }).notNull(),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  error: text('error'),
  raw: jsonb('raw'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('ticket_email_inbound_provider_msg_uq').on(t.partnerId, t.providerMessageId),
  index('ticket_email_inbound_review_idx').on(t.partnerId, t.parseStatus, t.createdAt)
]);

// Model-B seam: empty in v1; the custom-domain wizard manages it later.
export const partnerInboundDomains = pgTable('partner_inbound_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  domain: varchar('domain', { length: 255 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  providerDomainId: text('provider_domain_id'),
  verificationStatus: varchar('verification_status', { length: 20 }).notNull().default('pending'),
  dnsRecords: jsonb('dns_records'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  verifiedAt: timestamp('verified_at')
}, (t) => [
  uniqueIndex('partner_inbound_domains_domain_uq').on(t.domain),
  index('partner_inbound_domains_partner_idx').on(t.partnerId)
]);
