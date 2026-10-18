import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

export const AI_MODEL_REGISTRY_LEGACY_ARCHIVE_SOURCE_TABLES = [
  'partner_llm_configs',
  'partner_ai_connections',
  'ai_budgets',
  'ai_script_policies',
  'client_ai_org_policies',
  'ai_agents',
] as const;
export type AiModelRegistryLegacyArchiveSourceTable = (typeof AI_MODEL_REGISTRY_LEGACY_ARCHIVE_SOURCE_TABLES)[number];
const SOURCE_TABLE_LITERALS = AI_MODEL_REGISTRY_LEGACY_ARCHIVE_SOURCE_TABLES.map((t) => `'${t}'`).join(', ');

/**
 * Snapshot of the legacy AI model configuration archived and dropped by AI
 * model registry W08b (#7606), migration
 * 2026-12-30-200000-ai-model-registry-legacy-drop.sql. Partner axis (shape 3)
 * like legacy_labour_pricing_archive; org_id is metadata on org-level rows.
 * Never holds key material. Read-only history: nothing in the app writes it.
 * SQL owns the DEFERRABLE (org_id, partner_id) → organizations FK
 * (ON DELETE CASCADE, W08 D12).
 */
export const aiModelRegistryLegacyArchive = pgTable('ai_model_registry_legacy_archive', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id'),
  sourceTable: text('source_table').$type<AiModelRegistryLegacyArchiveSourceTable>().notNull(),
  sourceId: uuid('source_id').notNull(),
  /** 'row' for a non-secret snapshot of a partner_llm_configs row, else the dropped column's name. */
  sourceColumn: text('source_column').notNull(),
  value: jsonb('value').notNull(),
  /** Whether the partner had its registry row at archive time (false = its legacy value was never projected). */
  hadCutover: boolean('had_cutover').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('ai_model_registry_legacy_archive_source_uniq').on(t.sourceTable, t.sourceId, t.sourceColumn),
  check('ai_model_registry_legacy_archive_source_table_chk', sql`${t.sourceTable} IN (${sql.raw(SOURCE_TABLE_LITERALS)})`),
  index('ai_model_registry_legacy_archive_partner_idx').on(t.partnerId),
  index('ai_model_registry_legacy_archive_org_idx').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
]);

export type AiModelRegistryLegacyArchiveRow = typeof aiModelRegistryLegacyArchive.$inferSelect;
