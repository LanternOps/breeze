// apps/api/src/db/schema/aiPlatformModels.ts
import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ModelLifecycle, OptionRates, OptionSupport, PromptProfile } from '@breeze/shared';

/**
 * AI model registry W01 (#7599): system-wide platform model catalog.
 * No tenant column and no RLS (INTENTIONAL_UNSCOPED, same posture as
 * llm_provider_catalog). Writes: the ai-model-discovery worker and
 * /admin/ai-models (platform admin + MFA) only. Prices are cents per million
 * tokens; NULL = unpriced. Migration: 2026-11-13-100000-ai-platform-models.sql.
 */
export const aiPlatformModels = pgTable('ai_platform_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').$type<'anthropic'>().notNull().default('anthropic'),
  modelId: text('model_id').notNull(),
  displayName: text('display_name').notNull(),
  maxInputTokens: integer('max_input_tokens'),
  maxOutputTokens: integer('max_output_tokens'),
  /** Raw Models API `capabilities` tree, verbatim (spec §5.1). */
  capabilities: jsonb('capabilities').$type<unknown>(),
  inputCentsPerM: numeric('input_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  outputCentsPerM: numeric('output_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  cacheReadCentsPerM: numeric('cache_read_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  cacheWriteCentsPerM: numeric('cache_write_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  optionRates: jsonb('option_rates').$type<OptionRates>(),
  optionSupport: jsonb('option_support').$type<OptionSupport>().notNull()
    .default(sql`'{"effort":[],"thinkingDisplay":[],"speed":["standard"],"inferenceGeo":[]}'::jsonb`),
  minPlan: text('min_plan'),
  promptProfile: text('prompt_profile').$type<PromptProfile>().notNull().default('generic'),
  platformOffered: boolean('platform_offered').notNull().default(false),
  isPlatformDefault: boolean('is_platform_default').notNull().default(false),
  lifecycle: text('lifecycle').$type<ModelLifecycle>().notNull().default('available'),
  missedSyncCount: integer('missed_sync_count').notNull().default(0),
  operatorNotifiedAt: timestamp('operator_notified_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ai_platform_models_model_id_uq').on(t.modelId),
  uniqueIndex('ai_platform_models_one_default_uq').on(t.isPlatformDefault).where(sql`is_platform_default`),
  check('ai_platform_models_provider_chk', sql`${t.provider} IN ('anthropic')`),
  check('ai_platform_models_lifecycle_chk', sql`${t.lifecycle} IN ('available', 'missing', 'retired')`),
  check('ai_platform_models_prompt_profile_chk', sql`${t.promptProfile} IN ('claude-frontier', 'claude-standard', 'claude-small', 'generic')`),
  check('ai_platform_models_offered_priced_chk', sql`NOT ${t.platformOffered} OR (${t.inputCentsPerM} IS NOT NULL AND ${t.outputCentsPerM} IS NOT NULL AND ${t.cacheReadCentsPerM} IS NOT NULL AND ${t.cacheWriteCentsPerM} IS NOT NULL)`),
  check('ai_platform_models_default_offered_chk', sql`NOT ${t.isPlatformDefault} OR ${t.platformOffered}`),
  check('ai_platform_models_missed_nonneg_chk', sql`${t.missedSyncCount} >= 0`),
]);

export type AiPlatformModelRow = typeof aiPlatformModels.$inferSelect;
