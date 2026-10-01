// AI model registry (#7598) — the partner-owned half of the registry. W02
// (#7600) ships the tables; W03 cuts routing over. ai_platform_models (W01)
// is the system-wide half and lives in its own schema file.
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { llmProviderCatalog } from './llmProviderCatalog';
import { partners } from './orgs';
import { users } from './users';

export const PARTNER_AI_CONNECTION_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible'] as const;
export type PartnerAiConnectionKind = (typeof PARTNER_AI_CONNECTION_KINDS)[number];

/**
 * Shape 3 (partner axis). `api_key_encrypted` is registered row-bound under
 * the legacy `partner_llm_configs.api_key_encrypted` AAD tag (copied rows keep
 * their id). `legacy_default_model` is the /ai/provider compat projection of
 * `partner_llm_configs.default_model`; nothing routes on it; dropped in W08.
 */
export const partnerAiConnections = pgTable('partner_ai_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<PartnerAiConnectionKind>().notNull(),
  name: text('name').notNull(),
  inferenceGeo: text('inference_geo'),
  providerConfig: jsonb('provider_config').$type<Record<string, unknown>>(),
  apiKeyEncrypted: text('api_key_encrypted'),
  keyLast4: text('key_last4'),
  keyFingerprint: text('key_fingerprint'),
  catalogEntryId: uuid('catalog_entry_id').references(() => llmProviderCatalog.id),
  baseUrl: text('base_url'),
  status: text('status', { enum: ['active', 'error'] }).notNull().default('active'),
  lastError: text('last_error'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  configVersion: integer('config_version').notNull().default(1),
  connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
  lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true }),
  discoveryError: text('discovery_error'),
  legacyDefaultModel: text('legacy_default_model'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('partner_ai_connections_id_partner_uq').on(t.id, t.partnerId),
  index('partner_ai_connections_partner_idx').on(t.partnerId),
  uniqueIndex('partner_ai_connections_compat_uq').on(t.partnerId)
    .where(sql`${t.kind} IN ('anthropic_byok', 'catalog')`),
  check('partner_ai_connections_kind_chk', sql`${t.kind} IN ('anthropic_byok', 'catalog', 'openai_compatible')`),
  check('partner_ai_connections_status_chk', sql`${t.status} IN ('active', 'error')`),
  check('partner_ai_connections_shape_chk', sql`(${t.kind} = 'catalog') = (${t.catalogEntryId} IS NOT NULL) AND (${t.kind} = 'openai_compatible') = (${t.baseUrl} IS NOT NULL) AND (${t.kind} NOT IN ('anthropic_byok', 'catalog') OR ${t.apiKeyEncrypted} IS NOT NULL)`),
  check('partner_ai_connections_key_triplet_chk', sql`num_nulls(${t.apiKeyEncrypted}, ${t.keyLast4}, ${t.keyFingerprint}) IN (0, 3)`),
  check('partner_ai_connections_config_version_chk', sql`${t.configVersion} >= 1`),
]);

export type PartnerAiConnectionRow = typeof partnerAiConnections.$inferSelect;
