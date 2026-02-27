import { boolean, index, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export const auditBaselines = pgTable('audit_baselines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  osType: varchar('os_type', { length: 20 }).notNull(),
  profile: varchar('profile', { length: 20 }).notNull(),
  settings: jsonb('settings').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgOsIdx: index('audit_baselines_org_os_idx').on(table.orgId, table.osType),
  orgActiveIdx: index('audit_baselines_org_active_idx').on(table.orgId, table.isActive),
}));

export const auditBaselineResults = pgTable('audit_baseline_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  baselineId: uuid('baseline_id').notNull().references(() => auditBaselines.id, { onDelete: 'cascade' }),
  compliant: boolean('compliant').notNull(),
  score: integer('score').notNull(),
  deviations: jsonb('deviations').notNull(),
  checkedAt: timestamp('checked_at').notNull(),
  remediatedAt: timestamp('remediated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgDeviceIdx: index('audit_results_org_device_idx').on(table.orgId, table.deviceId),
  checkedAtIdx: index('audit_results_checked_at_idx').on(table.checkedAt),
  baselineCheckedIdx: index('audit_results_baseline_checked_idx').on(table.baselineId, table.checkedAt),
}));

export const auditPolicyStates = pgTable('audit_policy_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  osType: varchar('os_type', { length: 20 }).notNull(),
  settings: jsonb('settings').notNull(),
  raw: jsonb('raw'),
  collectedAt: timestamp('collected_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgDeviceCollectedIdx: index('audit_policy_states_org_device_collected_idx').on(table.orgId, table.deviceId, table.collectedAt),
  deviceCollectedIdx: index('audit_policy_states_device_collected_idx').on(table.deviceId, table.collectedAt),
  orgCollectedIdx: index('audit_policy_states_org_collected_idx').on(table.orgId, table.collectedAt),
}));

export const auditBaselineApplyApprovals = pgTable('audit_baseline_apply_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  baselineId: uuid('baseline_id').notNull().references(() => auditBaselines.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  approvedBy: uuid('approved_by').references(() => users.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  requestPayload: jsonb('request_payload').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  approvedAt: timestamp('approved_at'),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgStatusIdx: index('audit_baseline_apply_approvals_org_status_idx').on(table.orgId, table.status),
  baselineIdx: index('audit_baseline_apply_approvals_baseline_idx').on(table.baselineId),
  expiresAtIdx: index('audit_baseline_apply_approvals_expires_at_idx').on(table.expiresAt),
}));
