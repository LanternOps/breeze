import { sql } from 'drizzle-orm';
import { pgTable, text, uuid, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  clientSecretHash: text('client_secret_hash'),
  metadata: jsonb('metadata').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (table) => ({
  partnerIdx: index('oauth_clients_partner_idx')
    .on(table.partnerId)
    .where(sql`${table.partnerId} IS NOT NULL`),
}));

// oauth_client_partner_grants: join table marking which (client, partner)
// pairs have an active consented relationship. Introduced to replace the
// single-winner `oauth_clients.partner_id` pointer — a DCR client is shared
// across partners (same client_id registered once, every tenant that
// installs reuses it), and each partner needs independent visibility +
// revocation. The old `oauth_clients.partner_id` column is kept for a
// transition period (see migration 2026-04-24-oauth-client-partner-grants.sql
// header for the deprecation TODO) but is no longer written by the consent
// route.
export const oauthClientPartnerGrants = pgTable('oauth_client_partner_grants', {
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  firstConsentedAt: timestamp('first_consented_at', { withTimezone: true }).defaultNow().notNull(),
  lastConsentedAt: timestamp('last_consented_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.clientId, table.partnerId] }),
  partnerIdx: index('oauth_client_partner_grants_partner_idx').on(table.partnerId),
}));

export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  // partner_id is nullable: oidc-provider mints auth codes without our
  // partner concept (it's tracked on the long-lived Grant instead).
  // See migration 2026-04-24-oauth-auth-codes-partner-nullable.sql.
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('oauth_auth_codes_user_idx').on(table.userId),
  expiresIdx: index('oauth_auth_codes_expires_idx').on(table.expiresAt),
}));

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  userIdx: index('oauth_refresh_tokens_user_idx').on(table.userId),
  partnerIdx: index('oauth_refresh_tokens_partner_idx').on(table.partnerId),
  clientIdx: index('oauth_refresh_tokens_client_idx').on(table.clientId),
}));

// oauth_sessions: oidc-provider Session payloads (was in-memory, now persisted
// so OAuth flows survive API restart). Schema designed in migration
// 2026-04-24-oauth-sessions-grants.sql.
export const oauthSessions = pgTable('oauth_sessions', {
  id: text('id').primaryKey(),
  uid: text('uid').notNull(),
  accountId: uuid('account_id').references(() => users.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  uidIdx: index('oauth_sessions_uid_idx').on(table.uid),
  accountIdx: index('oauth_sessions_account_idx')
    .on(table.accountId)
    .where(sql`${table.accountId} IS NOT NULL`),
  expiresIdx: index('oauth_sessions_expires_idx').on(table.expiresAt),
}));

// oauth_interactions: short-lived (~1 hour) OAuth interaction records that
// bridge /authorize, the consent UI, and the post-consent resume. Persisted
// so an API restart mid-flow doesn't 404 the user. Schema in migration
// 2026-04-24-oauth-interactions.sql.
export const oauthInteractions = pgTable('oauth_interactions', {
  id: text('id').primaryKey(),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  expiresIdx: index('oauth_interactions_expires_idx').on(table.expiresAt),
}));

// oauth_grants: persisted oidc-provider Grants. partner_id/org_id are
// populated by the consent route; payload carries the rest of the Grant
// state (resources, openid, rejected, rar) plus our breeze meta inline.
export const oauthGrants = pgTable('oauth_grants', {
  id: text('id').primaryKey(),
  accountId: uuid('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  accountIdx: index('oauth_grants_account_idx').on(table.accountId),
  clientIdx: index('oauth_grants_client_idx').on(table.clientId),
  partnerIdx: index('oauth_grants_partner_idx')
    .on(table.partnerId)
    .where(sql`${table.partnerId} IS NOT NULL`),
  expiresIdx: index('oauth_grants_expires_idx').on(table.expiresAt),
}));
