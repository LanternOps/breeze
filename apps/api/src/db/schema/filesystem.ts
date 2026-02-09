import {
  pgEnum,
  pgTable,
  uuid,
  timestamp,
  boolean,
  jsonb,
  bigint,
  real,
  text,
  index
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { users } from './users';

export const filesystemSnapshotTriggerEnum = pgEnum('filesystem_snapshot_trigger', ['on_demand', 'threshold']);
export const filesystemCleanupRunStatusEnum = pgEnum('filesystem_cleanup_run_status', ['previewed', 'executed', 'failed']);

export const deviceFilesystemSnapshots = pgTable('device_filesystem_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  capturedAt: timestamp('captured_at').defaultNow().notNull(),
  trigger: filesystemSnapshotTriggerEnum('trigger').notNull().default('on_demand'),
  partial: boolean('partial').notNull().default(false),
  summary: jsonb('summary').notNull().default({}),
  largestFiles: jsonb('largest_files').notNull().default([]),
  largestDirs: jsonb('largest_dirs').notNull().default([]),
  tempAccumulation: jsonb('temp_accumulation').notNull().default([]),
  oldDownloads: jsonb('old_downloads').notNull().default([]),
  unrotatedLogs: jsonb('unrotated_logs').notNull().default([]),
  trashUsage: jsonb('trash_usage').notNull().default([]),
  duplicateCandidates: jsonb('duplicate_candidates').notNull().default([]),
  cleanupCandidates: jsonb('cleanup_candidates').notNull().default([]),
  errors: jsonb('errors').notNull().default([]),
  rawPayload: jsonb('raw_payload').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  deviceCapturedIdx: index('idx_device_filesystem_snapshots_device_captured').on(table.deviceId, table.capturedAt),
}));

export const deviceFilesystemCleanupRuns = pgTable('device_filesystem_cleanup_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  requestedBy: uuid('requested_by').references(() => users.id),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  approvedAt: timestamp('approved_at'),
  plan: jsonb('plan').notNull().default({}),
  executedActions: jsonb('executed_actions').notNull().default([]),
  bytesReclaimed: bigint('bytes_reclaimed', { mode: 'number' }).notNull().default(0),
  status: filesystemCleanupRunStatusEnum('status').notNull().default('previewed'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  deviceRequestedIdx: index('idx_device_filesystem_cleanup_runs_device_requested').on(table.deviceId, table.requestedAt),
}));

export const deviceFilesystemScanState = pgTable('device_filesystem_scan_state', {
  deviceId: uuid('device_id').primaryKey().references(() => devices.id),
  lastRunMode: text('last_run_mode').notNull().default('baseline'),
  lastBaselineCompletedAt: timestamp('last_baseline_completed_at'),
  lastDiskUsedPercent: real('last_disk_used_percent'),
  checkpoint: jsonb('checkpoint').notNull().default({}),
  aggregate: jsonb('aggregate').notNull().default({}),
  hotDirectories: jsonb('hot_directories').notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
