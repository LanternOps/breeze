import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { scripts } from './scripts';
import { users } from './users';

export const automationTriggerTypeEnum = pgEnum('automation_trigger_type', ['schedule', 'event', 'webhook', 'manual']);
export const automationOnFailureEnum = pgEnum('automation_on_failure', ['stop', 'continue', 'notify']);
export const automationRunStatusEnum = pgEnum('automation_run_status', ['running', 'completed', 'failed', 'partial']);
export const policyEnforcementEnum = pgEnum('policy_enforcement', ['monitor', 'warn', 'enforce']);
export const complianceStatusEnum = pgEnum('compliance_status', ['compliant', 'non_compliant', 'pending', 'error']);

export const automations = pgTable('automations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  trigger: jsonb('trigger').notNull(),
  conditions: jsonb('conditions'),
  actions: jsonb('actions').notNull(),
  onFailure: automationOnFailureEnum('on_failure').notNull().default('stop'),
  notificationTargets: jsonb('notification_targets'),
  lastRunAt: timestamp('last_run_at'),
  runCount: integer('run_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const automationRuns = pgTable('automation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  automationId: uuid('automation_id').references(() => automations.id),
  configPolicyId: uuid('config_policy_id'),
  configItemName: varchar('config_item_name', { length: 200 }),
  triggeredBy: varchar('triggered_by', { length: 255 }).notNull(),
  status: automationRunStatusEnum('status').notNull().default('running'),
  devicesTargeted: integer('devices_targeted').notNull().default(0),
  devicesSucceeded: integer('devices_succeeded').notNull().default(0),
  devicesFailed: integer('devices_failed').notNull().default(0),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  logs: jsonb('logs').default([]),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const automationPolicies = pgTable('automation_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  targets: jsonb('targets').notNull(),
  rules: jsonb('rules').notNull(),
  enforcement: policyEnforcementEnum('enforcement').notNull().default('monitor'),
  checkIntervalMinutes: integer('check_interval_minutes').notNull().default(60),
  remediationScriptId: uuid('remediation_script_id').references(() => scripts.id),
  lastEvaluatedAt: timestamp('last_evaluated_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const automationPolicyCompliance = pgTable('automation_policy_compliance', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').references(() => automationPolicies.id),
  configPolicyId: uuid('config_policy_id'),
  configItemName: varchar('config_item_name', { length: 200 }),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  status: complianceStatusEnum('status').notNull().default('pending'),
  details: jsonb('details'),
  lastCheckedAt: timestamp('last_checked_at'),
  remediationAttempts: integer('remediation_attempts').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  configPolicyIdIdx: index('apc_config_policy_id_idx').on(table.configPolicyId),
  deviceIdIdx: index('apc_device_id_idx').on(table.deviceId),
}));
