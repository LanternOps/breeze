import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  integer
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { alertSeverityEnum } from './alerts';

export const maintenanceWindowStatusEnum = pgEnum('maintenance_window_status', [
  'scheduled',
  'active',
  'completed',
  'cancelled'
]);

export const maintenanceRecurrenceEnum = pgEnum('maintenance_recurrence', [
  'once',
  'daily',
  'weekly',
  'monthly',
  'custom'
]);

export const maintenanceWindows = pgTable('maintenance_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time').notNull(),
  timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
  recurrence: maintenanceRecurrenceEnum('recurrence').notNull().default('once'),
  recurrenceRule: jsonb('recurrence_rule'),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  siteIds: uuid('site_ids').array(),
  groupIds: uuid('group_ids').array(),
  deviceIds: uuid('device_ids').array(),
  suppressAlerts: boolean('suppress_alerts').notNull().default(false),
  suppressPatching: boolean('suppress_patching').notNull().default(false),
  suppressAutomations: boolean('suppress_automations').notNull().default(false),
  suppressScripts: boolean('suppress_scripts').notNull().default(false),
  allowedAlertSeverities: alertSeverityEnum('allowed_alert_severities').array(),
  allowedActions: jsonb('allowed_actions'),
  status: maintenanceWindowStatusEnum('status').notNull().default('scheduled'),
  notifyBefore: integer('notify_before'),
  notifyOnStart: boolean('notify_on_start').notNull().default(false),
  notifyOnEnd: boolean('notify_on_end').notNull().default(false),
  notificationChannels: jsonb('notification_channels'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const maintenanceOccurrences = pgTable('maintenance_occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  windowId: uuid('window_id').notNull().references(() => maintenanceWindows.id),
  startTime: timestamp('start_time').notNull(),
  endTime: timestamp('end_time').notNull(),
  status: maintenanceWindowStatusEnum('status').notNull().default('scheduled'),
  overrides: jsonb('overrides'),
  actualStartTime: timestamp('actual_start_time'),
  actualEndTime: timestamp('actual_end_time'),
  suppressedAlerts: boolean('suppressed_alerts').notNull().default(false),
  suppressedPatches: boolean('suppressed_patches').notNull().default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
