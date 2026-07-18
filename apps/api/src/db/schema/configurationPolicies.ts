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
  real,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { alertSeverityEnum } from './alerts';
import { automationOnFailureEnum, policyEnforcementEnum } from './automations';
import { scripts } from './scripts';
import { eventLogLevelEnum } from './eventLogs';

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
  'event_log',
  'software_policy',
  'sensitive_data',
  'peripheral_control',
  'warranty',
  'helper',
  'remote_access',
  'pam',
  'onedrive_helper',
  'vulnerability',
]);

export const configAssignmentLevelEnum = pgEnum('config_assignment_level', [
  'partner',
  'organization',
  'site',
  'device_group',
  'device',
]);

export const backupModeEnum = pgEnum('backup_mode_enum', [
  'file',
  'hyperv',
  'mssql',
  'system_image',
]);

// A policy is owned by EITHER an org (orgId set, partnerId NULL — the original
// org-scoped shape) OR a partner (partnerId set, orgId NULL — "partner-wide /
// all orgs"). Exactly one axis is set per row; the CHECK constraint
// `configuration_policies_one_owner_chk` (migration 2026-06-27) enforces it.
export const configurationPolicies = pgTable('configuration_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: configPolicyStatusEnum('status').notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('config_policies_org_id_idx').on(table.orgId),
  partnerIdIdx: index('config_policies_partner_id_idx').on(table.partnerId),
  statusIdx: index('config_policies_status_idx').on(table.status),
}));

// Coarse per-organization material clocks for desired-configuration exports.
// Child definition/value tables advance these clocks through database-owned
// triggers so an incremental traversal cannot miss a nested change.
export const partnerExportConfigurationOrgState = pgTable('partner_export_configuration_org_state', {
  resource: varchar('resource', { length: 40 }).notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  updatedAt: timestamp('updated_at', { precision: 3 }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.resource, table.orgId] }),
  orgIdIdx: index('partner_export_configuration_org_state_org_id_idx').on(table.orgId),
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
  featurePolicyIdIdx: index('config_feature_links_feature_policy_id_idx')
    .on(table.featurePolicyId)
    .where(sql`${table.featurePolicyId} IS NOT NULL`),
  uniqueFeaturePerPolicy: uniqueIndex('config_feature_links_unique').on(table.configPolicyId, table.featureType),
}));

export const configPolicyAssignments = pgTable('config_policy_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  configPolicyId: uuid('config_policy_id').notNull().references(() => configurationPolicies.id, { onDelete: 'cascade' }),
  level: configAssignmentLevelEnum('level').notNull(),
  targetId: uuid('target_id').notNull(),
  priority: integer('priority').notNull().default(0),
  roleFilter: varchar('role_filter', { length: 30 }).array(),
  osFilter: varchar('os_filter', { length: 10 }).array(),
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
  // #1872: when true, the Windows agent suppresses the native Windows Update
  // automatic-install channel (NoAutoUpdate=1) so patches flow only through
  // Breeze. Breeze's own WUA-driven installs are unaffected.
  exclusiveWindowsUpdate: boolean('exclusive_windows_update').notNull().default(false),
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
  rebootIfPending: boolean('reboot_if_pending').notNull().default(false),
  notifyBeforeMinutes: integer('notify_before_minutes').default(15),
  notifyOnStart: boolean('notify_on_start').notNull().default(true),
  notifyOnEnd: boolean('notify_on_end').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Single-item: one row per feature link (event log settings)
export const configPolicyEventLogSettings = pgTable('config_policy_event_log_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  retentionDays: integer('retention_days').notNull().default(30),
  maxEventsPerCycle: integer('max_events_per_cycle').notNull().default(100),
  collectCategories: text('collect_categories').array().notNull().default(['security', 'hardware', 'application', 'system']),
  minimumLevel: eventLogLevelEnum('minimum_level').notNull().default('info'),
  // 15m default (was 5m) — issue #2390. Shadowed in practice (writes always go
  // through eventLogInlineSettingsSchema, which supplies the value), but kept in
  // sync to avoid latent drift. Migration: 2026-07-12-event-log-interval-default.sql
  collectionIntervalMinutes: integer('collection_interval_minutes').notNull().default(15),
  rateLimitPerHour: integer('rate_limit_per_hour').notNull().default(12000),
  enableFullTextSearch: boolean('enable_full_text_search').notNull().default(true),
  enableCorrelation: boolean('enable_correlation').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Single-item: one row per feature link (sensitive data scan settings)
export const configPolicySensitiveDataSettings = pgTable('config_policy_sensitive_data_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  detectionClasses: text('detection_classes').array().notNull().default(['credential']),
  includePaths: text('include_paths').array().notNull().default([]),
  excludePaths: text('exclude_paths').array().notNull().default([]),
  fileTypes: text('file_types').array().notNull().default([]),
  maxFileSizeBytes: integer('max_file_size_bytes').notNull().default(104857600),
  workers: integer('workers').notNull().default(4),
  timeoutSeconds: integer('timeout_seconds').notNull().default(300),
  suppressPatternIds: text('suppress_pattern_ids').array().notNull().default([]),
  scheduleType: varchar('schedule_type', { length: 20 }).notNull().default('manual'),
  intervalMinutes: integer('interval_minutes'),
  cron: varchar('cron', { length: 120 }),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Single-item: one row per feature link (backup settings)
export const configPolicyBackupSettings = pgTable('config_policy_backup_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  // Dual-axis mirror of the parent policy's ownership (org XOR partner) so
  // RLS never needs an EXISTS join to the parent. Partner-wide policies
  // write partner_id with org_id NULL (2026-07-13-backup-profiles.sql).
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  schedule: jsonb('schedule').notNull().default({}),
  retention: jsonb('retention').notNull().default({}),
  paths: jsonb('paths').notNull().default([]),
  backupMode: backupModeEnum('backup_mode').notNull().default('file'),
  targets: jsonb('targets').notNull().default({}),
  // Backup-profiles model (2026-07-13-backup-profiles.sql). When
  // backup_profile_id is set, the profile's selections replace
  // backup_mode/paths/targets (which remain the legacy "custom selection"
  // path). destination_config_id points at the backup_configs destination;
  // NULL with a profile set means "resolve the device org's default
  // destination at job time" (required for partner-wide policies). Real FKs
  // live in the SQL migration — no drizzle .references() here because
  // schema/backup.ts already imports from this module and a reference back
  // would create an import cycle.
  backupProfileId: uuid('backup_profile_id'),
  destinationConfigId: uuid('destination_config_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ============================================
// Monitoring (Service & Process) Per-Feature Tables
// ============================================

export const monitoringWatchTypeEnum = pgEnum('monitoring_watch_type', ['service', 'process']);

// Single-item: one row per feature link (monitoring settings)
export const configPolicyMonitoringSettings = pgTable('config_policy_monitoring_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  checkIntervalSeconds: integer('check_interval_seconds').notNull().default(60),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Single-item: one row per feature link (remote access settings)
export const configPolicyRemoteAccessSettings = pgTable('config_policy_remote_access_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  sessionPromptMode: text('session_prompt_mode').notNull().default('notify'),
  consentUnavailableBehavior: text('consent_unavailable_behavior').notNull().default('proceed'),
  notifyOnSessionEnd: boolean('notify_on_session_end').notNull().default(true),
  showActiveIndicator: boolean('show_active_indicator').notNull().default(true),
  technicianIdentityLevel: text('technician_identity_level').notNull().default('name_email'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Multi-item: one row per watch within a monitoring settings row
export const configPolicyMonitoringWatches = pgTable('config_policy_monitoring_watches', {
  id: uuid('id').primaryKey().defaultRandom(),
  settingsId: uuid('settings_id').notNull().references(() => configPolicyMonitoringSettings.id, { onDelete: 'cascade' }),
  watchType: monitoringWatchTypeEnum('watch_type').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  enabled: boolean('enabled').notNull().default(true),

  // Alert thresholds
  alertOnStop: boolean('alert_on_stop').notNull().default(true),
  alertAfterConsecutiveFailures: integer('alert_after_consecutive_failures').notNull().default(2),
  alertSeverity: alertSeverityEnum('alert_severity').notNull().default('high'),

  // Process-specific thresholds
  cpuThresholdPercent: real('cpu_threshold_percent'),
  memoryThresholdMb: real('memory_threshold_mb'),
  thresholdDurationSeconds: integer('threshold_duration_seconds').notNull().default(300),

  // Auto-remediation
  autoRestart: boolean('auto_restart').notNull().default(false),
  maxRestartAttempts: integer('max_restart_attempts').notNull().default(3),
  restartCooldownSeconds: integer('restart_cooldown_seconds').notNull().default(300),

  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  settingsIdIdx: index('cpmon_watches_settings_id_idx').on(table.settingsId),
}));
