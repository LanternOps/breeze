import { pgTable, uuid, varchar, text, timestamp, char, uniqueIndex } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

export const accountingConnections = pgTable('accounting_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  provider: varchar('provider', { length: 20 }).notNull(), // 'quickbooks' | 'xero'
  realmIdEncrypted: text('realm_id_encrypted'),
  accessTokenEncrypted: text('access_token_encrypted'),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  environment: varchar('environment', { length: 12 }).notNull().default('production'),
  homeCurrency: char('home_currency', { length: 3 }),
  defaultIncomeAccountRef: varchar('default_income_account_ref', { length: 64 }),
  defaultTaxCodeRef: varchar('default_tax_code_ref', { length: 64 }),
  pushMode: varchar('push_mode', { length: 10 }).notNull().default('auto'), // 'auto' | 'manual'
  webhookVerifierTokenEncrypted: text('webhook_verifier_token_encrypted'),
  cdcCursor: timestamp('cdc_cursor', { withTimezone: true }),
  status: varchar('status', { length: 20 }).notNull().default('connected'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  connectedBy: uuid('connected_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerProviderIdx: uniqueIndex('accounting_connections_partner_provider_idx')
    .on(table.partnerId, table.provider),
  idPartnerIdx: uniqueIndex('accounting_connections_id_partner_idx').on(table.id, table.partnerId),
}));
