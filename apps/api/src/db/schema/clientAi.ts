import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { portalUsers } from './portal';

/**
 * Breeze AI for Office — client-AI control-plane tables.
 * Spec: docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md §3, §7, §8, §10, §12.
 *
 * RLS lives in apps/api/migrations/2026-06-12-b-client-ai-foundation.sql:
 *  - client_ai_tenant_mappings / client_ai_org_policies / client_ai_usage: shape 1
 *    (breeze_org_isolation_* on breeze_has_org_access(org_id)).
 *  - client_ai_prompt_templates: DUAL-AXIS (org OR partner) — partner-wide rows
 *    have org_id NULL. See the custom_field_definitions lesson (2026-06-11-i).
 */

/** Entra tenant GUID → Breeze org. The tenant-isolation linchpin (spec §3). */
export const clientAiTenantMappings = pgTable('client_ai_tenant_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // GUID-shape CHECK lives in SQL (client_ai_tenant_mappings_tenant_guid_check).
  entraTenantId: text('entra_tenant_id').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  tenantUniq: uniqueIndex('client_ai_tenant_mappings_tenant_uniq').on(t.entraTenantId),
  orgUniq: uniqueIndex('client_ai_tenant_mappings_org_uniq').on(t.orgId),
}));

/** Per-org product policy (spec §7). Absence == disabled-with-defaults. */
export const clientAiOrgPolicies = pgTable('client_ai_org_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  userAccess: text('user_access').notNull().default('all'), // 'all' | 'selected' (SQL CHECK)
  selectedUserIds: jsonb('selected_user_ids').notNull().default([]), // portal_users UUIDs
  allowedProviders: jsonb('allowed_providers').notNull().default(['anthropic']),
  allowedModels: jsonb('allowed_models').notNull().default([]), // [] = provider defaults
  writeMode: text('write_mode').notNull().default('readwrite'), // 'readwrite' | 'readonly' (SQL CHECK)
  writeApproval: text('write_approval').notNull().default('ask'), // 'ask' | 'allow_auto' (SQL CHECK)
  dlpConfig: jsonb('dlp_config').notNull().default({}),
  dailyBudgetCents: integer('daily_budget_cents'), // NULL = unlimited
  monthlyBudgetCents: integer('monthly_budget_cents'), // NULL = unlimited
  perUserMessagesPerMinute: integer('per_user_messages_per_minute').notNull().default(10),
  orgMessagesPerHour: integer('org_messages_per_hour').notNull().default(500),
  retentionDays: integer('retention_days'), // NULL = keep forever
  branding: jsonb('branding').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgUniq: uniqueIndex('client_ai_org_policies_org_uniq').on(t.orgId),
}));

/** Daily/monthly metering buckets with a per-user dimension (spec §8). */
export const clientAiUsage = pgTable('client_ai_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  clientUserId: uuid('client_user_id').notNull().references(() => portalUsers.id, { onDelete: 'cascade' }),
  period: text('period').notNull(), // 'daily' | 'monthly' (SQL CHECK)
  periodKey: varchar('period_key', { length: 10 }).notNull(), // '2026-06-12' | '2026-06'
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  totalCostCents: real('total_cost_cents').notNull().default(0),
  sessionCount: integer('session_count').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  bucketUniq: uniqueIndex('client_ai_usage_bucket_uniq').on(t.orgId, t.clientUserId, t.period, t.periodKey),
}));

/**
 * Prompt templates (spec §10). Partner-wide rows: org_id NULL + partner_id set.
 * Org rows: org_id set + partner_id NULL. SQL CHECK enforces exactly one axis
 * (client_ai_prompt_templates_scope_check).
 */
export const clientAiPromptTemplates = pgTable('client_ai_prompt_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  promptBody: text('prompt_body').notNull(),
  category: varchar('category', { length: 100 }),
  // Host targeting: NULL ⇒ all hosts (default); a subset ⇒ only those hosts.
  // Filtered by the client list endpoint, validated against the host enum.
  hosts: text('hosts').array(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgIdx: index('client_ai_prompt_templates_org_idx').on(t.orgId),
  partnerIdx: index('client_ai_prompt_templates_partner_idx').on(t.partnerId),
}));

export type ClientAiTenantMappingRow = typeof clientAiTenantMappings.$inferSelect;
export type ClientAiOrgPolicyRow = typeof clientAiOrgPolicies.$inferSelect;
export type ClientAiUsageRow = typeof clientAiUsage.$inferSelect;
export type ClientAiPromptTemplateRow = typeof clientAiPromptTemplates.$inferSelect;
