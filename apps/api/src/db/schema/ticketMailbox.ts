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
import { partners, organizations } from './orgs';
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
  consentAttemptId: uuid('consent_attempt_id').notNull().defaultRandom(),
  // Provider discriminator, using the inbound pipeline's vocabulary so the
  // mailbox-generation lock compares message-vs-connection provider by direct
  // equality. 'm365' = MS Graph (tenant_id + ownership FK); 'gmail' = Google
  // Workspace (google_account_sub identity, org-scoped DWD creds).
  provider: varchar('provider', { length: 20 }).notNull().default('m365'),
  tenantId: uuid('tenant_id'),
  // Gmail only: the org whose google_workspace_connections holds the DWD service
  // account used to impersonate this mailbox. NULL for Microsoft (partner-scoped).
  // Bound to the connection's partner via the composite FK below.
  orgId: uuid('org_id'),
  // Gmail only: the mailbox's IMMUTABLE Google account `sub` (from OpenID UserInfo
  // via DWD at connect time; opaque string, never a number). Stable across
  // email/alias changes and never reused. It is the per-mailbox dedup namespace AND
  // the same-account proof used on reconnect to decide whether a preserved history
  // cursor still belongs to the same mailbox (see connectionService.createGmailConnection).
  googleAccountSub: varchar('google_account_sub', { length: 255 }),
  mailboxAddress: text('mailbox_address').notNull(),
  displayName: text('display_name'),
  status: varchar('status', { length: 20 }).notNull().default('pending_consent'),
  deltaLink: text('delta_link'),
  // Gmail incremental cursor (users.history startHistoryId). A STRING — Gmail
  // history IDs must never be parsed as JS numbers. Parallels deltaLink for MS.
  historyId: text('history_id'),
  // Gmail eligibility floor (connect time). Recovery after an expired cursor
  // ingests only mail at/after this instant, so it never imports pre-connect mail.
  eligibleAfter: timestamp('eligible_after', { withTimezone: true }),
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
  // Gmail tenant-isolation invariant: the credential-owning org must belong to
  // the connection's partner. NULL org_id (Microsoft rows) skips the FK.
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'ticket_mailbox_connections_org_partner_fk',
  }).onDelete('cascade'),
  providerCheck: check(
    'ticket_mailbox_connections_provider_check',
    sql`${table.provider} IN ('m365', 'gmail')`,
  ),
  // A connected mailbox must carry a provider-appropriate verified identity: a
  // Microsoft tenant, or a verified Google account sub PLUS the org whose DWD
  // service account reads it.
  connectedRequiresVerifiedTenant: check(
    'ticket_mailbox_connections_connected_requires_verified_tenant',
    sql`${table.status} <> 'connected'
      OR (${table.provider} = 'm365' AND ${table.tenantId} IS NOT NULL)
      OR (${table.provider} = 'gmail' AND ${table.googleAccountSub} IS NOT NULL AND ${table.orgId} IS NOT NULL)`,
  ),
  // Provider fields are mutually exclusive: a Microsoft row never carries the
  // Gmail identity/cursor columns, and a Gmail row never carries a Microsoft
  // tenant. Prevents a mixed row that would silently fail the provider-scoped
  // generation lock (tenant_id IS NOT DISTINCT FROM the Gmail null tenant).
  providerFieldsConsistent: check(
    'ticket_mailbox_connections_provider_fields_consistent',
    sql`(${table.provider} = 'm365'
         AND ${table.orgId} IS NULL AND ${table.googleAccountSub} IS NULL
         AND ${table.historyId} IS NULL AND ${table.eligibleAfter} IS NULL)
      OR (${table.provider} = 'gmail' AND ${table.tenantId} IS NULL)`,
  ),
}));

export type TicketMailboxConsentPhase = 'admin_consent' | 'identity_verification';

export const ticketMailboxConsentSessions = pgTable('ticket_mailbox_consent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: text('state').notNull().unique(),
  phase: varchar('phase', { length: 24 }).$type<TicketMailboxConsentPhase>().notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  connectionId: uuid('connection_id').notNull(),
  consentAttemptId: uuid('consent_attempt_id').notNull(),
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
