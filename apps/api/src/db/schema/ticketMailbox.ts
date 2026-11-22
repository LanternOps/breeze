import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
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
  verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
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
  // Eligibility floor (connect time), both providers. Mail received before this
  // instant is never ingested, whichever path surfaces it. NULL on a Microsoft 365
  // row until its tenant is bound (bindVerifiedTenant stamps it), and on a row from
  // before the floor existed until the poll sweep seeds one (#10863).
  eligibleAfter: timestamp('eligible_after', { withTimezone: true }),
  // Microsoft 365 only (#10863): the first delta round after a connect walks the
  // whole inbox and leaves what predates the floor alone. These record how many
  // messages it left and when it finished (NULL while it runs), for the mailbox
  // card. Only a count: the floor, not these, decides what is imported.
  baselineSkippedCount: integer('baseline_skipped_count').notNull().default(0),
  baselineCompletedAt: timestamp('baseline_completed_at', { withTimezone: true }),
  strictSenderAuth: boolean('strict_sender_auth').notNull().default(false),
  // Microsoft 365 only (#10862): the ARC sealing domains (the d= of an ARC-Seal) of
  // the inline mail gateways this mailbox's mail is relayed through. A seal that
  // verifies from one of them supplies the sender-auth verdict in place of Exchange's,
  // which judges relayed mail against the gateway. Empty = none, the default.
  trustedArcSealers: text('trusted_arc_sealers').array().notNull().default(sql`'{}'::text[]`),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  lastError: text('last_error'),
  // Microsoft 365 poll sweeps in a row that failed transiently (Graph 5xx/429,
  // network failure, sweep budget spent) and when the last one happened (#8308).
  // Reset by a successful poll or a reconnect. A counter and timestamp only: the
  // raw Graph error text stays in server logs, never in lastError (#6192).
  consecutiveTransientFailures: integer('consecutive_transient_failures').notNull().default(0),
  lastTransientFailureAt: timestamp('last_transient_failure_at', { withTimezone: true }),
  // When the Microsoft 365 poll sweep last started work on this mailbox, whether
  // or not Graph answered (#8308). The sweep takes mailboxes oldest attempt
  // first, so one its pass deadline did not reach goes first next sweep.
  lastPollAttemptAt: timestamp('last_poll_attempt_at', { withTimezone: true }),
  // Gmail only: per-mailbox "mark handled" (#7949). NULL label = off. When set,
  // mail that became (or joined) a ticket gets this USER label and, if
  // gmailArchiveOnHandle, leaves INBOX. Edited on the mailbox settings card.
  gmailHandledLabel: text('gmail_handled_label'),
  gmailArchiveOnHandle: boolean('gmail_archive_on_handle').notNull().default(true),
  // Last marking failure as a fixed code (GmailHandledErrorCode), shown on the
  // mailbox card; cleared by the next successful mark (except not_queued, which
  // is about other messages), a settings change or a reconnect. Never raw
  // upstream text.
  gmailHandledError: varchar('gmail_handled_error', { length: 32 }),
  gmailHandledErrorAt: timestamp('gmail_handled_error_at', { withTimezone: true }),
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
  // tenant or baseline state. Prevents a mixed row that would silently fail the
  // provider-scoped generation lock (tenant_id IS NOT DISTINCT FROM the Gmail
  // null tenant).
  providerFieldsConsistent: check(
    'ticket_mailbox_connections_provider_fields_consistent',
    sql`(${table.provider} = 'm365'
         AND ${table.orgId} IS NULL AND ${table.googleAccountSub} IS NULL
         AND ${table.historyId} IS NULL)
      OR (${table.provider} = 'gmail' AND ${table.tenantId} IS NULL
         AND ${table.baselineSkippedCount} = 0 AND ${table.baselineCompletedAt} IS NULL)`,
  ),
  baselineSkippedCountCheck: check(
    'ticket_mailbox_connections_baseline_skipped_count_check',
    sql`${table.baselineSkippedCount} >= 0`,
  ),
  trustedArcSealersCheck: check(
    'ticket_mailbox_connections_trusted_arc_sealers_check',
    sql`cardinality(${table.trustedArcSealers}) <= 10
      AND (${table.provider} = 'm365' OR cardinality(${table.trustedArcSealers}) = 0)`,
  ),
  gmailHandledLabelCheck: check(
    'ticket_mailbox_connections_gmail_handled_label_check',
    sql`${table.gmailHandledLabel} IS NULL
      OR (${table.provider} = 'gmail' AND char_length(${table.gmailHandledLabel}) BETWEEN 1 AND 100)`,
  ),
  gmailHandledErrorCheck: check(
    'ticket_mailbox_connections_gmail_handled_error_check',
    sql`${table.gmailHandledError} IS NULL
      OR ${table.gmailHandledError} IN ('access_denied', 'rate_limited', 'unavailable', 'label_invalid', 'no_credential', 'not_queued', 'failed')`,
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
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
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
