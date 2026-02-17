import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  pgEnum,
  integer,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { alertSeverityEnum } from './alerts';
import { automationOnFailureEnum, policyEnforcementEnum } from './automations';
import { scripts } from './scripts';

export const configPolicyStatusEnum = pgEnum('config_policy_status', [
  'active',
  'inactive',
  'archived',
]);

export const configFeatureTypeEnum = pgEnum('config_feature_type', [
  'patch',
  'alert_rule',
  'backup',
  'security',
  'monitoring',
  'maintenance',
  'compliance',
  'automation',
]);

export const configAssignmentLevelEnum = pgEnum('config_assignment_level', [
  'partner',
  'organization',
  'site',
  'device_group',
  'device',
]);

export const configurationPolicies = pgTable('configuration_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: configPolicyStatusEnum('status').notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('config_policies_org_id_idx').on(table.orgId),
  statusIdx: index('config_policies_status_idx').on(table.status),
}));

export const configPolicyFeatureLinks = pgTable('config_policy_feature_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  configPolicyId: uuid('config_policy_id').notNull().references(() => configurationPolicies.id, { onDelete: 'cascade' }),
  featureType: configFeatureTypeEnum('feature_type').notNull(),
  featurePolicyId: uuid('feature_policy_id'),
  inlineSettings: jsonb('inline_settings'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  configPolicyIdIdx: index('config_feature_links_policy_id_idx').on(table.configPolicyId),
  featureTypeIdx: index('config_feature_links_feature_type_idx').on(table.featureType),
  uniqueFeaturePerPolicy: uniqueIndex('config_feature_links_unique').on(table.configPolicyId, table.featureType),
}));

export const configPolicyAssignments = pgTable('config_policy_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  configPolicyId: uuid('config_policy_id').notNull().references(() => configurationPolicies.id, { onDelete: 'cascade' }),
  level: configAssignmentLevelEnum('level').notNull(),
  targetId: uuid('target_id').notNull(),
  priority: integer('priority').notNull().default(0),
  assignedBy: uuid('assigned_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  configPolicyIdIdx: index('config_assignments_policy_id_idx').on(table.configPolicyId),
  levelTargetIdx: index('config_assignments_level_target_idx').on(table.level, table.targetId),
  uniqueAssignment: uniqueIndex('config_assignments_unique').on(table.configPolicyId, table.level, table.targetId),
}));

// ============================================
// Normalized Per-Feature Tables
// ============================================

// Multi-item: one row per alert rule within a feature link
export const configPolicyAlertRules = pgTable('config_policy_alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  severity: alertSeverityEnum('severity').notNull(),
  conditions: jsonb('conditions').notNull(),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(5),
  autoResolve: boolean('auto_resolve').notNull().default(false),
  autoResolveConditions: jsonb('auto_resolve_conditions'),
  titleTemplate: text('title_template').notNull().default('{{ruleName}} triggered on {{deviceName}}'),
  messageTemplate: text('message_template').notNull().default('{{ruleName}} condition met'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  featureLinkIdIdx: index('cpar_feature_link_id_idx').on(table.featureLinkId),
}));

// Multi-item: one row per automation within a feature link
export const configPolicyAutomations = pgTable('config_policy_automations', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  triggerType: varchar('trigger_type', { length: 50 }).notNull(),
  cronExpression: varchar('cron_expression', { length: 100 }),
  timezone: varchar('timezone', { length: 100 }),
  eventType: varchar('event_type', { length: 200 }),
  actions: jsonb('actions').notNull(),
  onFailure: automationOnFailureEnum('on_failure').notNull().default('stop'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  featureLinkIdIdx: index('cpaut_feature_link_id_idx').on(table.featureLinkId),
  triggerTypeEnabledIdx: index('cpaut_trigger_type_enabled_idx').on(table.triggerType),
}));

// Multi-item: one row per compliance rule within a feature link
export const configPolicyComplianceRules = pgTable('config_policy_compliance_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  rules: jsonb('rules').notNull(),
  enforcementLevel: policyEnforcementEnum('enforcement_level').notNull().default('monitor'),
  checkIntervalMinutes: integer('check_interval_minutes').notNull().default(60),
  remediationScriptId: uuid('remediation_script_id').references(() => scripts.id),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  featureLinkIdIdx: index('cpcr_feature_link_id_idx').on(table.featureLinkId),
}));

// Single-item: one row per feature link (patch settings)
export const configPolicyPatchSettings = pgTable('config_policy_patch_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  sources: text('sources').array().notNull().default(['os']),
  autoApprove: boolean('auto_approve').notNull().default(false),
  autoApproveSeverities: text('auto_approve_severities').array().default([]),
  scheduleFrequency: varchar('schedule_frequency', { length: 20 }).notNull().default('weekly'),
  scheduleTime: varchar('schedule_time', { length: 10 }).notNull().default('02:00'),
  scheduleDayOfWeek: varchar('schedule_day_of_week', { length: 10 }).default('sun'),
  scheduleDayOfMonth: integer('schedule_day_of_month').default(1),
  rebootPolicy: varchar('reboot_policy', { length: 20 }).notNull().default('if_required'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Single-item: one row per feature link (maintenance settings)
export const configPolicyMaintenanceSettings = pgTable('config_policy_maintenance_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  recurrence: varchar('recurrence', { length: 20 }).notNull().default('weekly'),
  durationHours: integer('duration_hours').notNull().default(2),
  timezone: varchar('timezone', { length: 100 }).notNull().default('UTC'),
  /** ISO-8601 datetime for 'once' recurrence (e.g. "2026-03-15T02:00:00"). Ignored for other recurrence types. */
  windowStart: varchar('window_start', { length: 30 }),
  suppressAlerts: boolean('suppress_alerts').notNull().default(true),
  suppressPatching: boolean('suppress_patching').notNull().default(false),
  suppressAutomations: boolean('suppress_automations').notNull().default(false),
  suppressScripts: boolean('suppress_scripts').notNull().default(false),
  notifyBeforeMinutes: integer('notify_before_minutes').default(15),
  notifyOnStart: boolean('notify_on_start').notNull().default(true),
  notifyOnEnd: boolean('notify_on_end').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
