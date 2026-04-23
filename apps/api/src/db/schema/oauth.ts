import { sql } from 'drizzle-orm';
import { pgTable, text, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
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

export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
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
