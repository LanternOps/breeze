import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, index, uniqueIndex, check, foreignKey } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { devices } from './devices';
import { scripts } from './scripts';
import { users } from './users';
import { aiAgents } from './aiAgents';

export const automationTriggerTypeEnum = pgEnum('automation_trigger_type', ['schedule', 'event', 'webhook', 'manual']);
export const automationOnFailureEnum = pgEnum('automation_on_failure', ['stop', 'continue', 'notify']);
export const automationRunStatusEnum = pgEnum('automation_run_status', ['running', 'completed', 'failed', 'partial']);
export const automationResourceKindEnum = pgEnum('automation_resource_kind', ['script', 'software_catalog', 'notification_channel']);
export const automationResourceBindingStateEnum = pgEnum('automation_resource_binding_state', ['active', 'quarantined']);
// Per-device outcome within a single automation run (#2023). `pending` = row
// seeded before the device is processed; `running` = actively executing;
// terminal states are success/failed/skipped.
export const automationDeviceResultStatusEnum = pgEnum('automation_device_result_status', ['pending', 'running', 'success', 'failed', 'skipped']);
export const automationActionResultStatusEnum = pgEnum('automation_action_result_status', [
  'pending', 'queued', 'delivered', 'running',
  'succeeded', 'failed', 'skipped', 'timed_out', 'cancelled',
]);
export const automationActionTerminalSourceEnum = pgEnum('automation_action_terminal_source', [
  'command', 'script_execution', 'deployment_result', 'timeout', 'cancellation', 'reaper', 'dispatch',
]);
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
  /**
   * Set on the seeded, system-managed automation that wires an AI agent's
   * trigger (wave 3d, #3824). The ai_triage action resolves its agent through
   * this column; the routes layer rejects user edits to managed rows; the
   * seeder upserts on the partial unique automations_managed_by_agent_uq.
   * ON DELETE RESTRICT — agents are never hard-deleted.
   */
  managedByAgentId: uuid('managed_by_agent_id').references(() => aiAgents.id, {
    onDelete: 'restrict',
  }),
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

// Durable ownership snapshot for every resource referenced by a standalone
// automation. The binding copies the automation's dual owner axes; a database
// constraint trigger in 2026-09-25-a-automation-resource-bindings.sql rejects
// owner drift from the parent and expected resource owners outside that tenant.
// Task 3 consumes only active bindings at run admission and dispatch.
export const automationResourceBindings = pgTable('automation_resource_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  automationId: uuid('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  resourceKind: automationResourceKindEnum('resource_kind').notNull(),
  // Kept as text so malformed legacy JSON can be quarantined durably rather
  // than disappearing during the bounded migration backfill.
  resourceId: text('resource_id').notNull(),
  expectedResourceOrgId: uuid('expected_resource_org_id').references(() => organizations.id),
  expectedResourcePartnerId: uuid('expected_resource_partner_id').references(() => partners.id),
  expectedResourceIsSystem: boolean('expected_resource_is_system').notNull().default(false),
  state: automationResourceBindingStateEnum('state').notNull().default('active'),
  reason: varchar('reason', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  oneOwnerCheck: check(
    'automation_resource_bindings_one_owner_chk',
    sql`(${table.orgId} IS NULL) <> (${table.partnerId} IS NULL)`,
  ),
  expectedOwnerCheck: check(
    'automation_resource_bindings_expected_owner_chk',
    sql`(
      (${table.expectedResourceIsSystem} = true AND ${table.expectedResourceOrgId} IS NULL AND ${table.expectedResourcePartnerId} IS NULL)
      OR
      (${table.expectedResourceIsSystem} = false AND (${table.expectedResourceOrgId} IS NOT NULL OR ${table.expectedResourcePartnerId} IS NOT NULL))
    )`,
  ),
  automationIdx: index('automation_resource_bindings_automation_idx').on(table.automationId),
  orgIdx: index('automation_resource_bindings_org_idx').on(table.orgId),
  partnerIdx: index('automation_resource_bindings_partner_idx').on(table.partnerId),
  stateIdx: index('automation_resource_bindings_state_idx').on(table.state),
  automationResourceUnique: uniqueIndex('automation_resource_bindings_identity_uniq')
    .on(table.automationId, table.resourceKind, table.resourceId),
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

// One durable row per normalized action/device pair. Accepted asynchronous
// dispatch is deliberately nonterminal; command/script/deployment result paths
// advance these rows through guarded state transitions in the action-result
// service. org_id is copied from and pinned to the authoritative device so
// partner-wide automation runs remain directly tenant scoped.
export const automationActionResults = pgTable('automation_action_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => automationRuns.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  actionIndex: integer('action_index').notNull(),
  actionType: varchar('action_type', { length: 64 }).notNull(),
  status: automationActionResultStatusEnum('status').notNull().default('pending'),
  terminalSource: automationActionTerminalSourceEnum('terminal_source'),
  commandId: uuid('command_id'),
  scriptExecutionId: uuid('script_execution_id'),
  deploymentResultId: uuid('deployment_result_id'),
  message: text('message'),
  output: text('output'),
  error: text('error'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'automation_action_results_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
  check('automation_action_results_action_index_chk', sql`${table.actionIndex} >= 0`),
  uniqueIndex('automation_action_results_run_device_action_uq')
    .on(table.runId, table.deviceId, table.actionIndex),
  uniqueIndex('automation_action_results_command_uq')
    .on(table.commandId).where(sql`${table.commandId} IS NOT NULL`),
  uniqueIndex('automation_action_results_script_execution_uq')
    .on(table.scriptExecutionId).where(sql`${table.scriptExecutionId} IS NOT NULL`),
  uniqueIndex('automation_action_results_deployment_result_uq')
    .on(table.deploymentResultId).where(sql`${table.deploymentResultId} IS NOT NULL`),
  index('automation_action_results_run_idx').on(table.runId),
  index('automation_action_results_device_idx').on(table.deviceId),
  index('automation_action_results_org_idx').on(table.orgId),
  index('automation_action_results_status_updated_idx').on(table.status, table.updatedAt),
]);

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
  // Two shapes share this table and exactly one axis is populated per row, so
  // uniqueness is two PARTIAL indexes rather than table constraints (#4122).
  // `policyEvaluationService.ts` names these predicates verbatim as the
  // `targetWhere` of its ON CONFLICT arbiter — Postgres only infers a partial
  // index when the statement's predicate implies the index's, so the three
  // copies (here, migration 2026-09-29-100000, and the service) move together.
  policyDeviceUq: uniqueIndex('apc_policy_device_uq')
    .on(table.policyId, table.deviceId)
    .where(sql`${table.policyId} IS NOT NULL`),
  // config_item_name is nullable and NULLs never collide in a btree unique
  // index, so a row without one cannot be keyed — it stays outside the index
  // rather than being silently treated as a distinct key.
  configPolicyItemDeviceUq: uniqueIndex('apc_config_policy_item_device_uq')
    .on(table.configPolicyId, table.configItemName, table.deviceId)
    .where(sql`${table.configPolicyId} IS NOT NULL AND ${table.configItemName} IS NOT NULL`),
}));
