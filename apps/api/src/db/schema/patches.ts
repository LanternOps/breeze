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
  date,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';
import { scripts } from './scripts';

export const patchSourceEnum = pgEnum('patch_source', [
  'microsoft',
  'apple',
  'linux',
  'third_party',
  'custom'
]);

export const patchSeverityEnum = pgEnum('patch_severity', [
  'critical',
  'important',
  'moderate',
  'low',
  'unknown'
]);

export const patchApprovalStatusEnum = pgEnum('patch_approval_status', [
  'pending',
  'approved',
  'rejected',
  'deferred'
]);

export const devicePatchStatusEnum = pgEnum('device_patch_status', [
  'pending',
  'installed',
  'failed',
  'skipped',
  'missing'
]);

export const patchJobStatusEnum = pgEnum('patch_job_status', [
  'scheduled',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

export const patchJobResultStatusEnum = pgEnum('patch_job_result_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
]);

export const patchRollbackStatusEnum = pgEnum('patch_rollback_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

export const patchComplianceReportStatusEnum = pgEnum('patch_compliance_report_status', [
  'pending',
  'running',
  'completed',
  'failed'
]);

export const patchComplianceReportFormatEnum = pgEnum('patch_compliance_report_format', [
  'csv',
  'pdf'
]);

export const patches = pgTable('patches', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: patchSourceEnum('source').notNull(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  severity: patchSeverityEnum('severity'),
  category: varchar('category', { length: 100 }),
  osTypes: text('os_types').array(),
  osVersions: text('os_versions').array(),
  architecture: text('architecture').array(),
  releaseDate: date('release_date'),
  kbArticleUrl: text('kb_article_url'),
  supersedes: text('supersedes').array(),
  supersededBy: text('superseded_by'),
  requiresReboot: boolean('requires_reboot').notNull().default(false),
  downloadUrl: text('download_url'),
  downloadSizeMb: integer('download_size_mb'),
  installCommand: text('install_command'),
  uninstallCommand: text('uninstall_command'),
  detectScript: text('detect_script'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  sourceExternalIdUnique: uniqueIndex('patches_source_external_id_unique').on(table.source, table.externalId)
}));

export const patchPolicies = pgTable('patch_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  targets: jsonb('targets').notNull().default({}),
  sources: patchSourceEnum('sources').array(),
  autoApprove: jsonb('auto_approve').notNull().default({}),
  schedule: jsonb('schedule').notNull().default({}),
  rebootPolicy: jsonb('reboot_policy').notNull().default({}),
  rollbackOnFailure: boolean('rollback_on_failure').notNull().default(false),
  preInstallScript: uuid('pre_install_script_id').references(() => scripts.id),
  postInstallScript: uuid('post_install_script_id').references(() => scripts.id),
  notifyOnComplete: boolean('notify_on_complete').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const patchApprovals = pgTable('patch_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  policyId: uuid('policy_id').references(() => patchPolicies.id),
  status: patchApprovalStatusEnum('status').notNull().default('pending'),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  deferUntil: timestamp('defer_until'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgPatchUnique: uniqueIndex('patch_approvals_org_patch_unique').on(table.orgId, table.patchId)
}));

export const devicePatches = pgTable('device_patches', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  status: devicePatchStatusEnum('status').notNull().default('pending'),
  installedAt: timestamp('installed_at'),
  installedVersion: varchar('installed_version', { length: 100 }),
  lastCheckedAt: timestamp('last_checked_at'),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),
  rollbackAvailable: boolean('rollback_available').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  devicePatchUnique: uniqueIndex('device_patches_device_patch_unique').on(table.deviceId, table.patchId)
}));

export const patchJobs = pgTable('patch_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  policyId: uuid('policy_id').references(() => patchPolicies.id),
  configPolicyId: uuid('config_policy_id'),
  name: varchar('name', { length: 255 }).notNull(),
  patches: jsonb('patches').notNull().default({}),
  targets: jsonb('targets').notNull().default({}),
  status: patchJobStatusEnum('status').notNull().default('scheduled'),
  scheduledAt: timestamp('scheduled_at'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  devicesTotal: integer('devices_total').notNull().default(0),
  devicesCompleted: integer('devices_completed').notNull().default(0),
  devicesFailed: integer('devices_failed').notNull().default(0),
  devicesPending: integer('devices_pending').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const patchJobResults = pgTable('patch_job_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => patchJobs.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  status: patchJobResultStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  exitCode: integer('exit_code'),
  output: text('output'),
  errorMessage: text('error_message'),
  rebootRequired: boolean('reboot_required').notNull().default(false),
  rebootedAt: timestamp('rebooted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const patchRollbacks = pgTable('patch_rollbacks', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  patchId: uuid('patch_id').notNull().references(() => patches.id),
  originalJobId: uuid('original_job_id').references(() => patchJobs.id),
  reason: text('reason'),
  status: patchRollbackStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  output: text('output'),
  errorMessage: text('error_message'),
  initiatedBy: uuid('initiated_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const patchComplianceSnapshots = pgTable('patch_compliance_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  snapshotDate: date('snapshot_date').notNull(),
  totalDevices: integer('total_devices').notNull().default(0),
  compliantDevices: integer('compliant_devices').notNull().default(0),
  nonCompliantDevices: integer('non_compliant_devices').notNull().default(0),
  criticalMissing: integer('critical_missing').notNull().default(0),
  importantMissing: integer('important_missing').notNull().default(0),
  patchesPendingApproval: integer('patches_pending_approval').notNull().default(0),
  patchesInstalled24h: integer('patches_installed_24h').notNull().default(0),
  failedInstalls24h: integer('failed_installs_24h').notNull().default(0),
  detailsByCategory: jsonb('details_by_category').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

export const patchComplianceReports = pgTable('patch_compliance_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  requestedBy: uuid('requested_by').references(() => users.id),
  status: patchComplianceReportStatusEnum('status').notNull().default('pending'),
  format: patchComplianceReportFormatEnum('format').notNull().default('csv'),
  source: patchSourceEnum('source'),
  severity: patchSeverityEnum('severity'),
  summary: jsonb('summary'),
  rowCount: integer('row_count'),
  outputPath: text('output_path'),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
