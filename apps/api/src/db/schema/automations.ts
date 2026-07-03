import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { devices } from './devices';
import { scripts } from './scripts';
import { users } from './users';

export const automationTriggerTypeEnum = pgEnum('automation_trigger_type', ['schedule', 'event', 'webhook', 'manual']);
export const automationOnFailureEnum = pgEnum('automation_on_failure', ['stop', 'continue', 'notify']);
export const automationRunStatusEnum = pgEnum('automation_run_status', ['running', 'completed', 'failed', 'partial']);
// Per-device outcome within a single automation run (#2023). `pending` = row
// seeded before the device is processed; `running` = actively executing;
// terminal states are success/failed/skipped.
export const automationDeviceResultStatusEnum = pgEnum('automation_device_result_status', ['pending', 'running', 'success', 'failed', 'skipped']);
export const policyEnforcementEnum = pgEnum('policy_enforcement', ['monitor', 'warn', 'enforce']);
export const complianceStatusEnum = pgEnum('compliance_status', ['compliant', 'non_compliant', 'pending', 'error']);

// A standalone automation is owned by EITHER an org (orgId set, partnerId
// NULL — the original shape) OR a partner (partnerId set, orgId NULL —
// "partner-wide / all orgs", epic #2135 / #2133). Exactly one axis is set per
// row; the CHECK constraint `automations_one_owner_chk` (migration 2026-07-02)
// enforces it. Mirrors automationPolicies (#2129) below.
export const automations = pgTable('automations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
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
}, (table) => ({
  partnerIdIdx: index('automations_partner_id_idx').on(table.partnerId),
}));

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

// Per-device execution result for a single automation run (#2023). A child of
// automation_runs, one row per targeted device, giving the consolidated
// per-device pass/fail/pending breakdown + timing + output that the run's
// aggregate counters and jsonb logs can't express on their own.
//
// Tenancy (Shape 1, direct org_id): org_id is DENORMALIZED to the DEVICE's org
// — never the automation's. A partner-wide automation (automations.org_id NULL,
// #2133) has no org of its own, so worker-created child rows always take the
// device's org (the established pattern; see executeDeploySoftwareActions and
// the DUAL_AXIS note in rls-coverage.integration.test.ts). This makes the table
// auto-discovered by the RLS coverage contract test with a plain
// breeze_has_org_access(org_id) policy — no allowlist entry needed. Policies
// live in migration 2026-07-08-automation-run-device-results.sql.
export const automationRunDeviceResults = pgTable('automation_run_device_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => automationRuns.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  status: automationDeviceResultStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  output: text('output'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  runIdIdx: index('ardr_run_id_idx').on(table.runId),
  deviceIdIdx: index('ardr_device_id_idx').on(table.deviceId),
  orgIdIdx: index('ardr_org_id_idx').on(table.orgId),
  runDeviceUnique: uniqueIndex('ardr_run_device_unique').on(table.runId, table.deviceId),
}));

// An automation policy (the config-policy "compliance" feature's rule-set
// table) is owned by EITHER an org (orgId set, partnerId NULL — the original
// shape) OR a partner (partnerId set, orgId NULL — "partner-wide / all orgs",
// epic #2135 / #2129). Exactly one axis is set per row; the CHECK constraint
// `automation_policies_one_owner_chk` (migration 2026-07-01) enforces it.
// Mirrors software_policies (#2126).
export const automationPolicies = pgTable('automation_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
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
}, (table) => ({
  partnerIdIdx: index('automation_policies_partner_id_idx').on(table.partnerId),
}));

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
