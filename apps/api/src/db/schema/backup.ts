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
  bigint,
  index,
  type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';

export const backupProviderEnum = pgEnum('backup_provider', [
  'local',
  's3',
  'azure_blob',
  'google_cloud',
  'backblaze'
]);

export const backupTypeEnum = pgEnum('backup_type', [
  'file',
  'system_image',
  'database',
  'application'
]);

export const backupStatusEnum = pgEnum('backup_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'partial'
]);

export const backupJobTypeEnum = pgEnum('backup_job_type', [
  'scheduled',
  'manual',
  'incremental'
]);

export const restoreTypeEnum = pgEnum('restore_type', [
  'full',
  'selective',
  'bare_metal'
]);

export const backupConfigs = pgTable('backup_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  type: backupTypeEnum('type').notNull(),
  provider: backupProviderEnum('provider').notNull(),
  providerConfig: jsonb('provider_config').notNull(),
  schedule: jsonb('schedule'),
  retention: jsonb('retention'),
  compression: boolean('compression').notNull().default(true),
  encryption: boolean('encryption').notNull().default(true),
  encryptionKey: text('encryption_key'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('backup_configs_org_id_idx').on(table.orgId),
  typeIdx: index('backup_configs_type_idx').on(table.type),
  providerIdx: index('backup_configs_provider_idx').on(table.provider),
  activeIdx: index('backup_configs_active_idx').on(table.isActive)
}));

export const backupPolicies = pgTable('backup_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id').notNull().references(() => backupConfigs.id),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id').notNull(),
  includes: jsonb('includes').$type<string[]>().notNull().default([]),
  excludes: jsonb('excludes').$type<string[]>().notNull().default([]),
  priority: integer('priority').notNull().default(50)
}, (table) => ({
  configIdIdx: index('backup_policies_config_id_idx').on(table.configId),
  targetIdx: index('backup_policies_target_idx').on(table.targetType, table.targetId)
}));

export const backupJobs = pgTable('backup_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id').notNull().references(() => backupConfigs.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  status: backupStatusEnum('status').notNull().default('pending'),
  type: backupJobTypeEnum('type').notNull().default('scheduled'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  totalSize: bigint('total_size', { mode: 'bigint' }),
  transferredSize: bigint('transferred_size', { mode: 'bigint' }),
  fileCount: integer('file_count'),
  errorCount: integer('error_count'),
  errorLog: text('error_log'),
  snapshotId: varchar('snapshot_id', { length: 200 })
}, (table) => ({
  configIdIdx: index('backup_jobs_config_id_idx').on(table.configId),
  deviceIdIdx: index('backup_jobs_device_id_idx').on(table.deviceId),
  statusIdx: index('backup_jobs_status_idx').on(table.status),
  startedAtIdx: index('backup_jobs_started_at_idx').on(table.startedAt)
}));

export const backupSnapshots = pgTable('backup_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => backupJobs.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  snapshotId: varchar('snapshot_id', { length: 200 }).notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  size: bigint('size', { mode: 'bigint' }),
  fileCount: integer('file_count'),
  isIncremental: boolean('is_incremental').notNull().default(false),
  parentSnapshotId: uuid('parent_snapshot_id').references((): AnyPgColumn => backupSnapshots.id),
  expiresAt: timestamp('expires_at'),
  metadata: jsonb('metadata')
}, (table) => ({
  jobIdIdx: index('backup_snapshots_job_id_idx').on(table.jobId),
  deviceIdIdx: index('backup_snapshots_device_id_idx').on(table.deviceId),
  snapshotIdIdx: index('backup_snapshots_snapshot_id_idx').on(table.snapshotId),
  parentSnapshotIdIdx: index('backup_snapshots_parent_snapshot_id_idx').on(table.parentSnapshotId)
}));

export const restoreJobs = pgTable('restore_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  snapshotId: uuid('snapshot_id').notNull().references(() => backupSnapshots.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  restoreType: restoreTypeEnum('restore_type').notNull(),
  targetPath: text('target_path'),
  selectedPaths: jsonb('selected_paths').$type<string[]>().default([]),
  status: backupStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  restoredSize: bigint('restored_size', { mode: 'bigint' }),
  restoredFiles: integer('restored_files'),
  initiatedBy: uuid('initiated_by').references(() => users.id)
}, (table) => ({
  snapshotIdIdx: index('restore_jobs_snapshot_id_idx').on(table.snapshotId),
  deviceIdIdx: index('restore_jobs_device_id_idx').on(table.deviceId),
  statusIdx: index('restore_jobs_status_idx').on(table.status)
}));
