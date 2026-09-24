import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { alertSeverityEnum, escalationPolicies } from './alerts';
import { aiAgents } from './aiAgents';
import { configPolicyFeatureLinks } from './configurationPolicies';

/**
 * Monitoring & Automation unification, W02 (#5287 / #5289).
 *
 * A monitor definition is the single authored object (condition + severity +
 * responses + delivery). `services/monitors/monitorCompiler.ts` compiles it
 * into managed alert-template / alert-rule / automation rows, which is why
 * those three tables carry `managedByMonitorId` and are refused by every other
 * writer.
 *
 * Ownership follows CLAUDE.md "Partner-Wide First": org_id XOR partner_id,
 * enforced by `monitor_definitions_one_owner_chk`.
 */
export const monitorKindEnum = pgEnum('monitor_kind', [
  'cpu',
  'memory',
  'disk',
  'offline',
  'event_log',
  'patch_compliance',
  'service',
  'process',
  'process_resource',
  'cert_expiry',
  'bandwidth',
  'disk_io',
  'network_errors',
  // W04 coverage (#5287 / #5291) — added by
  // 2026-10-16-181300-monitor-coverage-kinds.sql. Order matches MONITOR_KINDS
  // in packages/shared so the two enums stay readable side by side.
  'antivirus',
  'software_presence',
  'backup_continuity',
  'script',
  'network_check',
  // W05c1 — 2026-10-23-103000-monitor-kind-composite.sql
  'composite',
  // W03 (hardware & RAID monitoring) —
  // 2026-10-30-110200-monitor-kind-hardware-health.sql
  'hardware_health',
]);

export const monitorDefinitions = pgTable(
  'monitor_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    kind: monitorKindEnum('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    condition: jsonb('condition').notNull().$type<Record<string, unknown>>(),
    severity: alertSeverityEnum('severity').notNull(),
    cooldownMinutes: integer('cooldown_minutes').notNull().default(5),
    autoResolve: boolean('auto_resolve').notNull().default(false),
    autoResolveConditions: jsonb('auto_resolve_conditions').$type<Record<string, unknown> | null>(),
    responses: jsonb('responses').notNull().default([]).$type<Array<Record<string, unknown>>>(),
    deliveryMode: varchar('delivery_mode', { length: 16 }).notNull().default('inherit'),
    deliveryChannelIds: jsonb('delivery_channel_ids').notNull().default([]).$type<string[]>(),
    escalationPolicyId: uuid('escalation_policy_id').references(() => escalationPolicies.id, {
      onDelete: 'set null',
    }),
    recurrenceThreshold: integer('recurrence_threshold'),
    recurrenceWindowHours: integer('recurrence_window_hours'),
    recurrenceActions: jsonb('recurrence_actions')
      .notNull()
      .default([])
      .$type<Array<Record<string, unknown>>>(),
    pauseResponsesOnEscalation: boolean('pause_responses_on_escalation').notNull().default(true),
    aiAgentId: uuid('ai_agent_id').references(() => aiAgents.id, { onDelete: 'set null' }),
    compiledAlertTemplateId: uuid('compiled_alert_template_id'),
    compiledAlertRuleId: uuid('compiled_alert_rule_id'),
    compiledAutomationId: uuid('compiled_automation_id'),
    compiledHash: text('compiled_hash'),
    compiledAt: timestamp('compiled_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    // Set on the partner-wide rows provisioned by services/monitors/
    // builtInMonitors.ts ('cpu_high' | 'memory_high' | 'disk_full'). NULL for
    // every user-authored monitor. CHECK: builtin_key IS NULL OR partner_id IS NOT NULL.
    builtinKey: varchar('builtin_key', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('monitor_definitions_org_id_idx').on(table.orgId),
    partnerIdIdx: index('monitor_definitions_partner_id_idx').on(table.partnerId),
    ownerNameUidx: uniqueIndex('monitor_definitions_owner_name_uidx').on(
      sql`COALESCE(${table.orgId}, ${table.partnerId})`,
      sql`lower(${table.name})`,
    ),
  }),
);

/**
 * Attachment of a monitor to a configuration policy, under that policy's
 * `monitors` feature link. No org_id: the tenant is reached through
 * config_policy_feature_links -> configuration_policies (PARENT_FK_JOIN RLS
 * shape). Owner compatibility is enforced in the database by the deferred
 * constraint trigger `config_policy_monitors_compat_trg`.
 */
export const configPolicyMonitors = pgTable(
  'config_policy_monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    featureLinkId: uuid('feature_link_id')
      .notNull()
      .references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitorDefinitions.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    overrides: jsonb('overrides').$type<Record<string, unknown> | null>(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    linkMonitorUidx: uniqueIndex('config_policy_monitors_link_monitor_uidx').on(
      table.featureLinkId,
      table.monitorId,
    ),
    monitorIdIdx: index('config_policy_monitors_monitor_id_idx').on(table.monitorId),
  }),
);

export type MonitorDefinitionRow = typeof monitorDefinitions.$inferSelect;
export type ConfigPolicyMonitorRow = typeof configPolicyMonitors.$inferSelect;
