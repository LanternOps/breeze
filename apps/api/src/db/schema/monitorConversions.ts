import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { configurationPolicies } from './configurationPolicies';
import { alertRules } from './alerts';
import { monitorDefinitions, configPolicyMonitors } from './monitorDefinitions';

/**
 * Alerting consolidation W05c1 — the conversion ledger (spec §Conversion).
 * Owned on the same axis as the converted policy: org_id XOR partner_id
 * (`*_one_owner_chk` in 2026-10-23-110000-monitor-conversions.sql).
 */
export const MONITOR_CONVERSION_SOURCE_TABLES = [
  'config_policy_alert_rules',
  'config_policy_monitoring_watches',
  'alert_templates',
  'automations',
  'config_policy_automations',
  'network_monitors', // W05e
] as const;
export type MonitorConversionSourceTable = (typeof MONITOR_CONVERSION_SOURCE_TABLES)[number];

export const MONITOR_CONVERSION_OUTPUT_ROLES = ['primary', 'resource_cpu', 'resource_memory', 'response'] as const;
export type MonitorConversionOutputRole = (typeof MONITOR_CONVERSION_OUTPUT_ROLES)[number];

export const monitorConversions = pgTable(
  'monitor_conversions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    sourceTable: text('source_table').$type<MonitorConversionSourceTable>().notNull(),
    sourceId: uuid('source_id').notNull(),
    policyId: uuid('policy_id').references(() => configurationPolicies.id, { onDelete: 'set null' }),
    convertedBy: uuid('converted_by').references(() => users.id, { onDelete: 'set null' }),
    convertedAt: timestamp('converted_at', { withTimezone: true }).defaultNow().notNull(),
    previewHash: text('preview_hash').notNull(),
    networkSourceSnapshot: jsonb('network_source_snapshot'),
    sourceState: jsonb('source_state').notNull().default({}).$type<Record<string, unknown>>(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('monitor_conversions_org_id_idx').on(table.orgId),
    partnerIdIdx: index('monitor_conversions_partner_id_idx').on(table.partnerId),
    liveSourceUidx: uniqueIndex('monitor_conversions_live_source_uidx')
      .on(table.sourceTable, table.sourceId)
      .where(sql`${table.revertedAt} IS NULL`),
    idOrgUidx: uniqueIndex('monitor_conversions_id_org_uidx').on(table.id, table.orgId),
    idPartnerUidx: uniqueIndex('monitor_conversions_id_partner_uidx').on(table.id, table.partnerId),
  }),
);

export const monitorConversionOutputs = pgTable(
  'monitor_conversion_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversionId: uuid('conversion_id')
      .notNull()
      .references(() => monitorConversions.id, { onDelete: 'cascade' }),
    // Denormalised owner axes (same XOR as the parent). The composite FK
    // (conversion_id, org_id) and (conversion_id, partner_id) deferrable FKs
    // live in SQL; Task 18 tests them against Postgres. Drift checks filenames only.
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    monitorId: uuid('monitor_id').references(() => monitorDefinitions.id, { onDelete: 'set null' }),
    role: text('role').$type<MonitorConversionOutputRole>().notNull(),
    movedAlertIds: jsonb('moved_alert_ids').notNull().default([]).$type<string[]>(),
    movedAlertRefs: jsonb('moved_alert_refs').notNull().default([]).$type<Array<{
      id: string; ruleId: string | null; configPolicyId: string | null;
      subjectKey?: string | null;
      monitorId: string | null; context: Record<string, unknown> | null;
    }>>(),
    reusedMonitor: boolean('reused_monitor').notNull().default(false),
    sourceRuleId: uuid('source_rule_id').references(() => alertRules.id, { onDelete: 'set null' }),
    policyId: uuid('policy_id').references(() => configurationPolicies.id, { onDelete: 'set null' }),
    attachmentId: uuid('attachment_id').references(() => configPolicyMonitors.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    conversionIdIdx: index('monitor_conversion_outputs_conversion_id_idx').on(table.conversionId),
    orgIdIdx: index('monitor_conversion_outputs_org_id_idx').on(table.orgId),
    partnerIdIdx: index('monitor_conversion_outputs_partner_id_idx').on(table.partnerId),
  }),
);

export type MonitorConversionRow = typeof monitorConversions.$inferSelect;
export type MonitorConversionOutputRow = typeof monitorConversionOutputs.$inferSelect;
