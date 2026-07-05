import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  integer,
  index,
  numeric,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { NOTIFICATION_CHANNEL_TYPES } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { devices } from './devices';
import { users } from './users';

export const alertSeverityEnum = pgEnum('alert_severity', ['critical', 'high', 'medium', 'low', 'info']);
// 'dismissed' is terminal: hidden from list views by default and honored by
// synthetic-alert evaluators (warranty expiry) so a dismissed alert is never
// re-created for the same underlying condition.
export const alertStatusEnum = pgEnum('alert_status', ['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed']);
export const notificationChannelTypeEnum = pgEnum('notification_channel_type', NOTIFICATION_CHANNEL_TYPES);

export const alertTemplates = pgTable('alert_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  conditions: jsonb('conditions').notNull(),
  severity: alertSeverityEnum('severity').notNull(),
  titleTemplate: text('title_template').notNull(),
  messageTemplate: text('message_template').notNull(),
  targets: jsonb('targets'),
  autoResolve: boolean('auto_resolve').notNull().default(false),
  autoResolveConditions: jsonb('auto_resolve_conditions'),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(5),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// An alert rule is owned by EITHER an org (orgId set, partnerId NULL — the
// original shape) OR a partner (partnerId set, orgId NULL — "partner-wide /
// all orgs", epic #2135 / #2128). Exactly one axis is set per row; the CHECK
// constraint `alert_rules_one_owner_chk` (migration 2026-07-01) enforces it.
// Partner-wide rules always use targetType 'all' with targetId = partnerId
// (targetId is NOT NULL; the 'all' match ignores it). Fired alerts ALWAYS
// carry the device's org (alerts.org_id NOT NULL), never the rule's.
export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  templateId: uuid('template_id').notNull().references(() => alertTemplates.id),
  name: varchar('name', { length: 200 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id').notNull(),
  overrideSettings: jsonb('override_settings'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('alert_rules_org_id_idx').on(table.orgId),
  partnerIdIdx: index('alert_rules_partner_id_idx').on(table.partnerId),
  templateIdIdx: index('alert_rules_template_id_idx').on(table.templateId)
}));

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  ruleId: uuid('rule_id').references(() => alertRules.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  configPolicyId: uuid('config_policy_id'),
  configItemName: varchar('config_item_name', { length: 200 }),
  status: alertStatusEnum('status').notNull().default('active'),
  severity: alertSeverityEnum('severity').notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  message: text('message'),
  context: jsonb('context'),
  triggeredAt: timestamp('triggered_at').defaultNow().notNull(),
  acknowledgedAt: timestamp('acknowledged_at'),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolutionNote: text('resolution_note'),
  suppressedUntil: timestamp('suppressed_until'),
  dismissedAt: timestamp('dismissed_at'),
  dismissedBy: uuid('dismissed_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  // Backs the `alerts.critical` device-filter field (#968).
  activeCriticalIdx: index('idx_alerts_active_critical')
    .on(table.deviceId)
    .where(sql`status = 'active' AND severity = 'critical'`),
  // Backs the suppression-expiry reaper's due-rows scan
  // (apps/api/src/jobs/suppressionExpiryReaper.ts).
  suppressedExpiryIdx: index('idx_alerts_suppressed_expiry')
    .on(table.suppressedUntil)
    .where(sql`status = 'suppressed' AND suppressed_until IS NOT NULL`)
}));

export const alertCorrelations = pgTable('alert_correlations', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentAlertId: uuid('parent_alert_id').notNull().references(() => alerts.id),
  childAlertId: uuid('child_alert_id').notNull().references(() => alerts.id),
  correlationType: varchar('correlation_type', { length: 50 }).notNull(),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  parentAlertIdIdx: index('alert_correlations_parent_alert_id_idx').on(table.parentAlertId),
  childAlertIdIdx: index('alert_correlations_child_alert_id_idx').on(table.childAlertId)
}));

export const alertCorrelationGroups = pgTable('alert_correlation_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  groupKey: varchar('group_key', { length: 255 }).notNull(),
  rootAlertId: uuid('root_alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 40 }).notNull().default('open'),
  score: numeric('score', { precision: 3, scale: 2 }),
  noiseReductionPercent: integer('noise_reduction_percent').notNull().default(0),
  memberCount: integer('member_count').notNull().default(0),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgKeyUniq: uniqueIndex('alert_correlation_groups_org_key_uq').on(table.orgId, table.groupKey),
  orgStatusSeenIdx: index('alert_correlation_groups_org_status_seen_idx').on(table.orgId, table.status, table.lastSeenAt),
  rootAlertIdx: index('alert_correlation_groups_root_alert_idx').on(table.rootAlertId)
}));

export const alertCorrelationMembers = pgTable('alert_correlation_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  groupId: uuid('group_id').notNull().references(() => alertCorrelationGroups.id, { onDelete: 'cascade' }),
  alertId: uuid('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 40 }).notNull().default('related'),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  evidence: jsonb('evidence').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  groupAlertUniq: uniqueIndex('alert_correlation_members_group_alert_uq').on(table.groupId, table.alertId),
  orgAlertIdx: index('alert_correlation_members_org_alert_idx').on(table.orgId, table.alertId),
  orgGroupIdx: index('alert_correlation_members_org_group_idx').on(table.orgId, table.groupId)
}));

// Delivery rails (#2131 sibling, issue #2130): a channel / routing rule /
// escalation policy is owned by EITHER an org (orgId set, partnerId NULL —
// the original shape) OR a partner (partnerId set, orgId NULL — "partner-wide
// / all orgs", epic #2135). Exactly one axis per row; CHECK constraints
// `*_one_owner_chk` (migration 2026-07-01) enforce it. alert_notifications
// stay alert-join (the alert's org) and are unchanged.
export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  type: notificationChannelTypeEnum('type').notNull(),
  config: jsonb('config').notNull(),
  templates: jsonb('templates').default({}),
  enabled: boolean('enabled').notNull().default(true),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestStatus: varchar('last_test_status', { length: 16 }),
  // Feature #4: per-channel sliding-window throttle. NULL = unlimited.
  throttleMaxPerWindow: integer('throttle_max_per_window'),
  throttleWindowSeconds: integer('throttle_window_seconds').default(3600),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerIdIdx: index('notification_channels_partner_id_idx').on(table.partnerId),
}));

export const notificationRoutingRules = pgTable('notification_routing_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  priority: integer('priority').notNull(),
  conditions: jsonb('conditions').notNull(), // { severities?, conditionTypes?, deviceTags?, siteIds? }
  channelIds: jsonb('channel_ids').notNull().$type<string[]>(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('notification_routing_rules_org_id_idx').on(table.orgId),
  priorityIdx: index('notification_routing_rules_priority_idx').on(table.orgId, table.priority),
  partnerIdIdx: index('notification_routing_rules_partner_id_idx').on(table.partnerId),
}));

export const escalationPolicies = pgTable('escalation_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  steps: jsonb('steps').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerIdIdx: index('escalation_policies_partner_id_idx').on(table.partnerId),
}));

export const alertNotifications = pgTable('alert_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertId: uuid('alert_id').notNull().references(() => alerts.id),
  channelId: uuid('channel_id').notNull().references(() => notificationChannels.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  sentAt: timestamp('sent_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
