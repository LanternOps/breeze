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
  numeric
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';

export const alertSeverityEnum = pgEnum('alert_severity', ['critical', 'high', 'medium', 'low', 'info']);
export const alertStatusEnum = pgEnum('alert_status', ['active', 'acknowledged', 'resolved', 'suppressed']);
export const notificationChannelTypeEnum = pgEnum('notification_channel_type', ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms']);

export const alertTemplates = pgTable('alert_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  conditions: jsonb('conditions').notNull(),
  severity: alertSeverityEnum('severity').notNull(),
  titleTemplate: text('title_template').notNull(),
  messageTemplate: text('message_template').notNull(),
  autoResolve: boolean('auto_resolve').notNull().default(false),
  autoResolveConditions: jsonb('auto_resolve_conditions'),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(5),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  templateId: uuid('template_id').notNull().references(() => alertTemplates.id),
  name: varchar('name', { length: 200 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id').notNull(),
  overrideSettings: jsonb('override_settings'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('alert_rules_org_id_idx').on(table.orgId),
  templateIdIdx: index('alert_rules_template_id_idx').on(table.templateId)
}));

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  ruleId: uuid('rule_id').notNull().references(() => alertRules.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
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
  createdAt: timestamp('created_at').defaultNow().notNull()
});

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

export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  type: notificationChannelTypeEnum('type').notNull(),
  config: jsonb('config').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const escalationPolicies = pgTable('escalation_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  steps: jsonb('steps').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const alertNotifications = pgTable('alert_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertId: uuid('alert_id').notNull().references(() => alerts.id),
  channelId: uuid('channel_id').notNull().references(() => notificationChannels.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  sentAt: timestamp('sent_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
