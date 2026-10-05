// AI model registry (#7598) — the partner-owned half of the registry. W02
// (#7600) ships the tables; W03 cuts routing over. ai_platform_models (W01)
// is the system-wide half and lives in its own schema file.
import { sql } from 'drizzle-orm';
import type { AiSurface, ModelLifecycle } from '@breeze/shared';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiPlatformModels } from './aiPlatformModels';
import { llmProviderCatalog } from './llmProviderCatalog';
import { organizations, partners } from './orgs';
import { users } from './users';

export const PARTNER_AI_CONNECTION_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible'] as const;
export type PartnerAiConnectionKind = (typeof PARTNER_AI_CONNECTION_KINDS)[number];

/**
 * Shape 3 (partner axis). `api_key_encrypted` is registered row-bound under
 * the legacy 'partner_llm_configs.api_key_encrypted' AAD tag (rows copied from
 * the retired legacy table keep their id, so every stored key still opens).
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
  status: text('status', { enum: ['active', 'error', 'disconnected'] }).notNull().default('active'),
  lastError: text('last_error'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  configVersion: integer('config_version').notNull().default(1),
  connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
  lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true }),
  discoveryError: text('discovery_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('partner_ai_connections_id_partner_uq').on(t.id, t.partnerId),
  index('partner_ai_connections_partner_idx').on(t.partnerId),
  // Disconnected rows are kept as provenance (#7700 finding 1) and do not count.
  uniqueIndex('partner_ai_connections_compat_uq').on(t.partnerId)
    .where(sql`${t.kind} IN ('anthropic_byok', 'catalog') AND ${t.status} <> 'disconnected'`),
  check('partner_ai_connections_kind_chk', sql`${t.kind} IN ('anthropic_byok', 'catalog', 'openai_compatible')`),
  check('partner_ai_connections_status_chk', sql`${t.status} IN ('active', 'error', 'disconnected')`),
  check('partner_ai_connections_shape_chk', sql`(${t.kind} = 'catalog') = (${t.catalogEntryId} IS NOT NULL) AND (${t.kind} = 'openai_compatible') = (${t.baseUrl} IS NOT NULL) AND (${t.kind} NOT IN ('anthropic_byok', 'catalog') OR ${t.status} = 'disconnected' OR ${t.apiKeyEncrypted} IS NOT NULL)`),
  check('partner_ai_connections_disconnected_keyless_chk', sql`${t.status} <> 'disconnected' OR ${t.apiKeyEncrypted} IS NULL`),
  check('partner_ai_connections_key_triplet_chk', sql`num_nulls(${t.apiKeyEncrypted}, ${t.keyLast4}, ${t.keyFingerprint}) IN (0, 3)`),
  check('partner_ai_connections_config_version_chk', sql`${t.configVersion} >= 1`),
]);

export type PartnerAiConnectionRow = typeof partnerAiConnections.$inferSelect;

export const PARTNER_AI_MODEL_SOURCES = ['platform', 'discovered', 'manual', 'catalog'] as const;
export type PartnerAiModelSource = (typeof PARTNER_AI_MODEL_SOURCES)[number];

const priceColumn = (name: string) => numeric(name, { precision: 20, scale: 6, mode: 'number' });

/**
 * Shape 3 (partner axis) + a SELECT-only org-token branch on enabled rows
 * (`partner_ai_models_org_read_enabled`). Platform offerings carry only
 * `platformModelId`; catalog offerings carry only `modelId` (spec §5.3).
 */
export const partnerAiModels = pgTable('partner_ai_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id'),
  platformModelId: uuid('platform_model_id').references(() => aiPlatformModels.id),
  modelId: text('model_id'),
  source: text('source').$type<PartnerAiModelSource>().notNull(),
  displayName: text('display_name'),
  capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
  priceInputCentsPerM: priceColumn('price_input_cents_per_m'),
  priceOutputCentsPerM: priceColumn('price_output_cents_per_m'),
  priceCacheReadCentsPerM: priceColumn('price_cache_read_cents_per_m'),
  priceCacheWriteCentsPerM: priceColumn('price_cache_write_cents_per_m'),
  enabled: boolean('enabled').notNull().default(false),
  defaultOptions: jsonb('default_options').$type<Record<string, unknown>>(),
  allowedOptions: jsonb('allowed_options').$type<Record<string, unknown>>(),
  requiredPermission: text('required_permission'),
  refusalFallbackOfferingId: uuid('refusal_fallback_offering_id'),
  lifecycle: text('lifecycle').$type<ModelLifecycle>().notNull().default('available'),
  /** W03 connection discovery (#7601): NULL until a sync observes the model; never-seen rows are never aged. */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  missedSyncCount: integer('missed_sync_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('partner_ai_models_id_partner_uq').on(t.id, t.partnerId),
  foreignKey({
    columns: [t.connectionId, t.partnerId],
    foreignColumns: [partnerAiConnections.id, partnerAiConnections.partnerId],
    name: 'partner_ai_models_connection_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.refusalFallbackOfferingId, t.partnerId],
    foreignColumns: [t.id, t.partnerId],
    name: 'partner_ai_models_refusal_fallback_fk',
  }),
  uniqueIndex('partner_ai_models_platform_uq').on(t.partnerId, t.platformModelId).where(sql`${t.connectionId} IS NULL`),
  uniqueIndex('partner_ai_models_connection_model_uq').on(t.connectionId, t.modelId).where(sql`${t.connectionId} IS NOT NULL`),
  index('partner_ai_models_partner_idx').on(t.partnerId),
  index('partner_ai_models_platform_model_idx').on(t.platformModelId).where(sql`${t.platformModelId} IS NOT NULL`),
  index('partner_ai_models_refusal_fallback_idx').on(t.refusalFallbackOfferingId).where(sql`${t.refusalFallbackOfferingId} IS NOT NULL`),
  check('partner_ai_models_source_chk', sql`${t.source} IN ('platform', 'discovered', 'manual', 'catalog')`),
  check('partner_ai_models_lifecycle_chk', sql`${t.lifecycle} IN ('available', 'missing', 'retired')`),
]);

export type PartnerAiModelRow = typeof partnerAiModels.$inferSelect;

/**
 * org_id XOR partner_id (dual-axis + partner-wide SELECT branch). See the
 * migration header for the NULL-means-inherit semantics of every column.
 */
export const aiModelAssignments = pgTable('ai_model_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  offeringPartnerId: uuid('offering_partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  surface: text('surface').$type<AiSurface>().notNull(),
  role: text('role').notNull().default('default'),
  defaultOfferingId: uuid('default_offering_id'),
  options: jsonb('options').$type<Record<string, unknown>>(),
  fallbackOfferingIds: uuid('fallback_offering_ids').array(),
  fallbackMayCrossFunding: boolean('fallback_may_cross_funding'),
  permittedOfferingIds: uuid('permitted_offering_ids').array(),
  allowUserChoice: boolean('allow_user_choice'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.orgId, t.offeringPartnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'ai_model_assignments_org_partner_fk',
  }),
  foreignKey({
    columns: [t.defaultOfferingId, t.offeringPartnerId],
    foreignColumns: [partnerAiModels.id, partnerAiModels.partnerId],
    name: 'ai_model_assignments_default_offering_fk',
  }),
  uniqueIndex('ai_model_assignments_partner_uq').on(t.partnerId, t.surface, t.role).where(sql`${t.orgId} IS NULL`),
  uniqueIndex('ai_model_assignments_org_uq').on(t.orgId, t.surface, t.role).where(sql`${t.orgId} IS NOT NULL`),
  index('ai_model_assignments_offering_partner_idx').on(t.offeringPartnerId),
  index('ai_model_assignments_default_offering_idx').on(t.defaultOfferingId).where(sql`${t.defaultOfferingId} IS NOT NULL`),
  check('ai_model_assignments_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  check('ai_model_assignments_partner_owner_chk', sql`${t.partnerId} IS NULL OR ${t.partnerId} = ${t.offeringPartnerId}`),
]);

export type AiModelAssignmentRow = typeof aiModelAssignments.$inferSelect;
