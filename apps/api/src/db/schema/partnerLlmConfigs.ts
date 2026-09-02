import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { llmProviderCatalog } from './llmProviderCatalog';
import { partners } from './orgs';
import { users } from './users';

export const partnerLlmConfigs = pgTable('partner_llm_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'cascade' }),
  provider: text('provider', { enum: ['anthropic'] }).notNull().default('anthropic'),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  keyLast4: text('key_last4').notNull(),
  keyFingerprint: text('key_fingerprint').notNull(),
  baseUrl: text('base_url'),
  defaultModel: text('default_model'),
  // Phase 2 (#3922) catalog selection. No onDelete: deleting a catalog entry
  // with partners still pinned to it must fail loud (see the migration).
  catalogEntryId: uuid('catalog_entry_id').references(() => llmProviderCatalog.id),
  status: text('status', { enum: ['active', 'error'] }).notNull().default('active'),
  configVersion: integer('config_version').notNull().default(1),
  lastError: text('last_error'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('partner_llm_configs_partner_uq').on(table.partnerId),
  check('partner_llm_configs_provider_chk', sql`${table.provider} = 'anthropic'`),
  check('partner_llm_configs_base_url_chk', sql`${table.baseUrl} IS NULL`),
  check('partner_llm_configs_status_chk', sql`${table.status} IN ('active', 'error')`),
]);
