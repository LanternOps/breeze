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
  index,
  primaryKey
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export const filesystemSnapshotTriggerEnum = pgEnum('filesystem_snapshot_trigger', ['on_demand', 'threshold']);
// `running` is last because that is the order ALTER TYPE added it
// (2026-10-21-110100-…), which is the order Postgres sorts the labels in.
export const filesystemCleanupRunStatusEnum = pgEnum('filesystem_cleanup_run_status', ['previewed', 'executed', 'failed', 'running']);

export const deviceFilesystemSnapshots = pgTable('device_filesystem_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /**
   * The NORMALISED volume/path this scan covered (spec §4). Always written
   * through `normalizeScanPath(osType, path)` (`@breeze/shared`) — a snapshot
   * keyed on a raw `c:\` would never be found by a `C:\` read, which is
   * defect 6.
   *
   * Required after W03's contraction; W02's deployed writers supply it.
   */
  scanPath: text('scan_path').notNull(),
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
  devicePathCapturedIdx: index('idx_device_filesystem_snapshots_device_path_captured')
    .on(table.deviceId, table.scanPath, table.capturedAt.desc()),
}));

export const deviceFilesystemCleanupRuns = pgTable('device_filesystem_cleanup_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /** Nullable: a `kind='system'` run cleans the machine, not a path. */
  scanPath: text('scan_path'),
  /** 'files' (the itemized file engine) | 'system' (W04's native cleaners). */
  kind: text('kind').notNull().default('files'),
  /**
   * The queued `system_cleanup_run` command for a system run (W04). No FK:
   * device_commands rows are pruned independently, and a pruned command must
   * not take the record of what was done with it.
   */
  commandId: uuid('command_id'),
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
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  /** Second half of the primary key: one checkpoint/baseline per volume. */
  scanPath: text('scan_path').notNull(),
  /**
   * The `filesystem_analysis` command id that started the run currently owning
   * this row (spec §13 #18). Producers set it when queuing
   * (`setFilesystemScanGeneration`); the result handler CLAIMS it with a
   * conditional update. The separate receipt below identifies duplicates;
   * a NULL generation remains claimable for legacy/unregistered commands.
   */
  scanGeneration: uuid('scan_generation'),
  /** Last successfully persisted command; written in the snapshot transaction. */
  lastAppliedCommandId: uuid('last_applied_command_id'),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  lastRunMode: text('last_run_mode').notNull().default('baseline'),
  lastBaselineCompletedAt: timestamp('last_baseline_completed_at'),
  lastDiskUsedPercent: real('last_disk_used_percent'),
  checkpoint: jsonb('checkpoint').notNull().default({}),
  aggregate: jsonb('aggregate').notNull().default({}),
  hotDirectories: jsonb('hot_directories').notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  pk: primaryKey({ name: 'device_filesystem_scan_state_pkey', columns: [table.deviceId, table.scanPath] }),
}));
