// apps/api/src/db/schema/llmProviderCatalog.ts
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/** Prices are integer cents per million tokens, matching MODEL_PRICING units. */
export interface LlmProviderModelMapEntry {
  providerModel: string;          // the id sent to the endpoint (e.g. 'anthropic/claude-sonnet-4-6' on OpenRouter)
  inputCentsPerM: number;
  outputCentsPerM: number;
  cacheReadCentsPerM: number;
  cacheWriteCentsPerM: number;
}
/** Keyed by OFFERABLE_AI_MODELS logical ids. Only mapped models are selectable. */
export type LlmProviderModelMap = Record<string, LlmProviderModelMapEntry>;

export const llmProviderCatalog = pgTable('llm_provider_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'listed', 'delisted'] }).notNull().default('draft'),
  activeRevisionId: uuid('active_revision_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('llm_provider_catalog_slug_uq').on(t.slug)]);

export const llmProviderCatalogRevisions = pgTable('llm_provider_catalog_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogEntryId: uuid('catalog_entry_id').notNull().references(() => llmProviderCatalog.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  baseUrl: text('base_url').notNull(),
  authMode: text('auth_mode', { enum: ['x-api-key', 'bearer'] }).notNull(),
  modelMap: jsonb('model_map').$type<LlmProviderModelMap>().notNull(),
  dataNote: text('data_note'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('llm_provider_catalog_revisions_uq').on(t.catalogEntryId, t.revision)]);

export const llmProviderVerifications = pgTable('llm_provider_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  revisionId: uuid('revision_id').notNull().references(() => llmProviderCatalogRevisions.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  harnessVersion: text('harness_version').notNull(),
  passed: boolean('passed').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('llm_provider_verifications_rev_idx').on(t.revisionId, t.modelId, t.createdAt)]);
