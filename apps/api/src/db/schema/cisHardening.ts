import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  timestamp,
  boolean,
  jsonb,
  integer,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const cisBaselineLevelEnum = pgEnum('cis_baseline_level', ['l1', 'l2', 'custom']);
export const cisOsTypeEnum = pgEnum('cis_os_type', ['windows', 'macos', 'linux']);
export const cisCheckStatusEnum = pgEnum('cis_check_status', ['pass', 'fail', 'not_applicable', 'error']);
export const cisCheckSeverityEnum = pgEnum('cis_check_severity', ['low', 'medium', 'high', 'critical']);
export const cisRemediationStatusEnum = pgEnum('cis_remediation_status', [
  'pending_approval', 'queued', 'in_progress', 'completed', 'failed', 'cancelled',
]);
export const cisRemediationApprovalStatusEnum = pgEnum('cis_remediation_approval_status', [
  'pending', 'approved', 'rejected',
]);

export type CisBaselineLevel = (typeof cisBaselineLevelEnum.enumValues)[number];
export type CisOsType = (typeof cisOsTypeEnum.enumValues)[number];
export type CisCheckStatus = (typeof cisCheckStatusEnum.enumValues)[number];
export type CisCheckSeverity = (typeof cisCheckSeverityEnum.enumValues)[number];
export type CisRemediationStatus = (typeof cisRemediationStatusEnum.enumValues)[number];
export type CisRemediationApprovalStatus = (typeof cisRemediationApprovalStatusEnum.enumValues)[number];
export type CisCatalogLevel = Exclude<CisBaselineLevel, 'custom'>;

export const cisFindingSchema = z.object({
  checkId: z.string().min(1).max(120),
  title: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  status: z.enum(['pass', 'fail', 'not_applicable', 'error']),
  evidence: z.record(z.unknown()).nullable().optional(),
  remediation: z.object({
    action: z.string().optional(),
    commandType: z.string().optional(),
    payload: z.record(z.unknown()).optional(),
    rollbackHint: z.string().optional(),
  }).nullable().optional(),
  message: z.string().nullable().optional(),
});

export type CisFinding = z.infer<typeof cisFindingSchema>;

export type CisScanSchedule = {
  enabled: boolean;
  intervalHours: number;
  nextScanAt: string | null;
};

export const cisBaselines = pgTable('cis_baselines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  osType: cisOsTypeEnum('os_type').notNull(),
  benchmarkVersion: varchar('benchmark_version', { length: 40 }).notNull(),
  level: cisBaselineLevelEnum('level').notNull(),
  customExclusions: jsonb('custom_exclusions').$type<string[]>().notNull().default([]),
  scanSchedule: jsonb('scan_schedule').$type<CisScanSchedule>(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgOsIdx: index('cis_baselines_org_os_idx').on(table.orgId, table.osType),
  orgActiveIdx: index('cis_baselines_org_active_idx').on(table.orgId, table.isActive),
}));

export const cisBaselineResults = pgTable('cis_baseline_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  baselineId: uuid('baseline_id').notNull().references(() => cisBaselines.id, { onDelete: 'cascade' }),
  checkedAt: timestamp('checked_at').notNull(),
  totalChecks: integer('total_checks').notNull(),
  passedChecks: integer('passed_checks').notNull(),
  failedChecks: integer('failed_checks').notNull(),
  score: integer('score').notNull(),
  findings: jsonb('findings').$type<CisFinding[]>().notNull().default([]),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgDeviceCheckedIdx: index('cis_results_org_device_checked_idx').on(table.orgId, table.deviceId, table.checkedAt),
  baselineCheckedIdx: index('cis_results_baseline_checked_idx').on(table.baselineId, table.checkedAt),
  scoreIdx: index('cis_results_score_idx').on(table.score),
}));

export const cisCheckCatalog = pgTable('cis_check_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  osType: cisOsTypeEnum('os_type').notNull(),
  benchmarkVersion: varchar('benchmark_version', { length: 40 }).notNull(),
  level: cisBaselineLevelEnum('level').notNull(),
  checkId: varchar('check_id', { length: 120 }).notNull(),
  title: varchar('title', { length: 400 }).notNull(),
  severity: cisCheckSeverityEnum('severity').notNull(),
  defaultAction: varchar('default_action', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  uniqueCheckIdx: uniqueIndex('cis_check_catalog_unique_idx')
    .on(table.osType, table.benchmarkVersion, table.level, table.checkId),
  osBenchmarkIdx: index('cis_check_catalog_os_benchmark_idx').on(table.osType, table.benchmarkVersion),
}));

export const cisRemediationActions = pgTable('cis_remediation_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  baselineId: uuid('baseline_id').references(() => cisBaselines.id, { onDelete: 'set null' }),
  baselineResultId: uuid('baseline_result_id').references(() => cisBaselineResults.id, { onDelete: 'set null' }),
  checkId: varchar('check_id', { length: 120 }).notNull(),
  action: varchar('action', { length: 40 }).notNull(),
  status: cisRemediationStatusEnum('status').notNull().default('pending_approval'),
  approvalStatus: cisRemediationApprovalStatusEnum('approval_status').notNull().default('pending'),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  approvalNote: text('approval_note'),
  requestedBy: uuid('requested_by').references(() => users.id),
  commandId: uuid('command_id'),
  executedAt: timestamp('executed_at'),
  details: jsonb('details').$type<Record<string, unknown> | null>(),
  beforeState: jsonb('before_state').$type<Record<string, unknown> | null>(),
  afterState: jsonb('after_state').$type<Record<string, unknown> | null>(),
  rollbackHint: text('rollback_hint'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgDeviceStatusIdx: index('cis_remediation_org_device_status_idx').on(table.orgId, table.deviceId, table.status),
  orgApprovalStatusIdx: index('cis_remediation_org_approval_status_idx').on(table.orgId, table.approvalStatus, table.status),
  resultIdx: index('cis_remediation_result_idx').on(table.baselineResultId),
  checkIdx: index('cis_remediation_check_idx').on(table.checkId),
}));
