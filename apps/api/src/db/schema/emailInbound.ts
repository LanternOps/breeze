import { pgTable, uuid, text, varchar, timestamp, jsonb, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { tickets } from './portal';
import { users } from './users';

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

// Phase 5: sender-domain -> customer-org routing for email-to-ticket.
// Shape 3 (partner-axis) + denormalized org_id. The composite FK
// (org_id, partner_id) -> organizations(id, partner_id) is enforced in SQL only
// (Drizzle references() is single-column); see the 2026-06-20-a migration.
export const customerEmailDomains = pgTable('customer_email_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull(),
  domain: varchar('domain', { length: 255 }).notNull(),
  autoCreateContact: boolean('auto_create_contact').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('customer_email_domains_partner_domain_uq').on(t.partnerId, t.domain),
  index('customer_email_domains_lookup_idx').on(t.partnerId, t.isActive)
]);
