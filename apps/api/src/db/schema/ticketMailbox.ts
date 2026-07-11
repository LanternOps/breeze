import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

export const ticketMailboxTenantOwnerships = pgTable('ticket_mailbox_tenant_ownerships', {
  tenantId: uuid('tenant_id').primaryKey(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  verifiedBy: uuid('verified_by').references(() => users.id),
  verifiedMicrosoftOid: uuid('verified_microsoft_oid').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantPartnerUnique: unique('ticket_mailbox_tenant_ownerships_tenant_partner_unique')
    .on(table.tenantId, table.partnerId),
}));

export const ticketMailboxConnections = pgTable('ticket_mailbox_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  tenantId: uuid('tenant_id'),
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
  tenantPartnerFk: foreignKey({
    columns: [table.tenantId, table.partnerId],
    foreignColumns: [ticketMailboxTenantOwnerships.tenantId, ticketMailboxTenantOwnerships.partnerId],
    name: 'ticket_mailbox_connections_tenant_partner_fk',
  }),
  connectedRequiresVerifiedTenant: check(
    'ticket_mailbox_connections_connected_requires_verified_tenant',
    sql`${table.status} <> 'connected' OR ${table.tenantId} IS NOT NULL`,
  ),
}));

export type TicketMailboxConsentPhase = 'admin_consent' | 'identity_verification';

export const ticketMailboxConsentSessions = pgTable('ticket_mailbox_consent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: text('state').notNull().unique(),
  phase: varchar('phase', { length: 24 }).$type<TicketMailboxConsentPhase>().notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  connectionId: uuid('connection_id').notNull(),
  userId: uuid('user_id').references(() => users.id),
  tenantHintHash: text('tenant_hint_hash'),
  nonce: text('nonce'),
  codeVerifier: text('code_verifier'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [ticketMailboxConnections.id, ticketMailboxConnections.partnerId],
    name: 'ticket_mailbox_consent_sessions_connection_partner_fk',
  }).onDelete('cascade'),
  phaseCheck: check(
    'ticket_mailbox_consent_sessions_phase_check',
    sql`${table.phase} IN ('admin_consent', 'identity_verification')`,
  ),
}));
