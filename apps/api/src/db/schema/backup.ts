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
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { devices, deviceCommands } from './devices';
import { users } from './users';
import { configPolicyFeatureLinks, backupModeEnum } from './configurationPolicies';
import { storageEncryptionKeys } from './storageEncryption';

export const backupProviderEnum = pgEnum('backup_provider', [
  'local',
  's3',
  'azure_blob',
  'google_cloud',
  'backblaze',
]);

export const backupTypeEnum = pgEnum('backup_type', [
  'file',
  'system_image',
  'database',
  'application',
]);

export const backupStatusEnum = pgEnum('backup_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'partial',
]);

/**
 * The two non-terminal `backup_status` values. A job in one of these is still
 * in-flight and may legitimately accept a progress update or a terminal result;
 * the other four (completed / failed / cancelled / partial) are terminal.
 *
 * Single source of truth for the "terminal vs in-flight" invariant over
 * backupStatusEnum — imported by both services/backupProgress.ts and
 * services/backupResultPersistence.ts so the invariant is defined exactly once,
 * co-located with the enum it partitions.
 */
export const IN_FLIGHT_BACKUP_JOB_STATUSES = ['pending', 'running'] as const;

/**
 * Marker the stale-backup-job reaper (jobs/staleCommandReaper.ts) stamps into a
 * reaped job's `error_log`. The result-persistence path reads it to distinguish
 * a "failed-because-reaped" job from a user `cancelled` job or a genuine
 * agent-reported failure, so a late-but-genuine `completed` result can still be
 * recorded (flipping failed→completed) instead of stranding its already-uploaded
 * snapshot in the bucket with no backup_snapshots row. Contains no LIKE
 * metacharacters (`%` / `_`) so it is safe to match with a plain `LIKE`.
 */
export const STALE_BACKUP_REAP_MARKER = '[stale-backup-reaper]';

export const backupJobTypeEnum = pgEnum('backup_job_type', [
  'scheduled',
  'manual',
  'incremental',
]);

export const restoreTypeEnum = pgEnum('restore_type', [
  'full',
  'selective',
  'bare_metal',
]);

export const backupConfigs = pgTable(
  'backup_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: varchar('name', { length: 200 }).notNull(),
    type: backupTypeEnum('type').notNull(),
    provider: backupProviderEnum('provider').notNull(),
    providerConfig: jsonb('provider_config').notNull(),
    schedule: jsonb('schedule'),
    retention: jsonb('retention'),
    providerCapabilities: jsonb('provider_capabilities'),
    providerCapabilitiesCheckedAt: timestamp('provider_capabilities_checked_at'),
    compression: boolean('compression').notNull().default(true),
    encryption: boolean('encryption').notNull().default(false),
    encryptionKey: text('encryption_key'),
    isActive: boolean('is_active').notNull().default(true),
    // The org's default destination. Partner-wide config policies cannot pin
    // one org's credentials, so their backup links resolve to the device
    // org's default config at job-creation time. At most one per org
    // (partial unique index).
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('backup_configs_org_id_idx').on(table.orgId),
    typeIdx: index('backup_configs_type_idx').on(table.type),
    providerIdx: index('backup_configs_provider_idx').on(table.provider),
    activeIdx: index('backup_configs_active_idx').on(table.isActive),
    orgDefaultUq: uniqueIndex('backup_configs_org_default_uq')
      .on(table.orgId)
      .where(sql`is_default`),
  })
);

// Backup selection profiles ("what to protect" for a device class) — the
// Cove-style entity from docs/superpowers/specs/backup/2026-07-13-backup-profiles-design.md.
// Dual-ownership per epic #2135: org_id XOR partner_id (CHECK + dual-axis RLS
// live in 2026-07-13-backup-profiles.sql). `selections` enables any subset of
// source types — keys match backup_mode_enum (file / system_image / mssql /
// hyperv), each with per-source options; shape validated by
// backupProfileSelectionsSchema in @breeze/shared.
export const backupProfiles = pgTable(
  'backup_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    selections: jsonb('selections').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('backup_profiles_org_id_idx').on(table.orgId),
    partnerIdIdx: index('backup_profiles_partner_id_idx').on(table.partnerId),
    activeIdx: index('backup_profiles_active_idx').on(table.isActive),
  })
);

export const backupPolicies = pgTable(
  'backup_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    configId: uuid('config_id')
      .notNull()
      .references(() => backupConfigs.id),
    name: varchar('name', { length: 200 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    schedule: jsonb('schedule').notNull(),
    retention: jsonb('retention').notNull(),
    targets: jsonb('targets').notNull(),
    gfsConfig: jsonb('gfs_config'),
    legalHold: boolean('legal_hold').default(false),
    legalHoldReason: text('legal_hold_reason'),
    bandwidthLimitMbps: integer('bandwidth_limit_mbps'),
    backupWindowStart: varchar('backup_window_start', { length: 5 }),
    backupWindowEnd: varchar('backup_window_end', { length: 5 }),
    priority: integer('priority').default(50),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    configIdIdx: index('backup_policies_config_id_idx').on(table.configId),
    orgIdIdx: index('backup_policies_org_id_idx').on(table.orgId),
    enabledIdx: index('backup_policies_enabled_idx').on(table.enabled),
  })
);

export const backupJobs = pgTable(
  'backup_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    configId: uuid('config_id')
      .notNull()
      .references(() => backupConfigs.id),
    policyId: uuid('policy_id').references(() => backupPolicies.id),
    // SET NULL (not cascade): feature_link_id is nullable and backup_jobs are
    // execution/audit history with a lifecycle independent of the policy link —
    // removing the Backup feature must not destroy backup history (or the only
    // rows tracking objects already in storage). Unlinking just detaches. The
    // job's own children (snapshots/verifications) DO cascade from the job below.
    featureLinkId: uuid('feature_link_id').references(() => configPolicyFeatureLinks.id, {
      onDelete: 'set null',
    }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    status: backupStatusEnum('status').notNull().default('pending'),
    type: backupJobTypeEnum('type').notNull().default('scheduled'),
    // Profile fan-out (spec 2026-07-13): a profile with N enabled selections
    // creates N jobs per occurrence, each carrying its own mode + targets so
    // dispatch doesn't depend on the (mutable) settings row. NULL = legacy
    // job; dispatch falls back to reading the feature link's settings.
    backupMode: backupModeEnum('backup_mode'),
    modeTargets: jsonb('mode_targets'),
    // timestamptz to match last_progress_at below: the stale reaper COALESCEs
    // started_at with last_progress_at, which is only correct when both carry
    // timezone. Aligned by migration 2026-08-02-align-backup-jobs-timestamptz.sql.
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    totalSize: bigint('total_size', { mode: 'number' }),
    transferredSize: bigint('transferred_size', { mode: 'number' }),
    fileCount: integer('file_count'),
    errorCount: integer('error_count'),
    errorLog: text('error_log'),
    snapshotId: varchar('snapshot_id', { length: 200 }),
    vssMetadata: jsonb('vss_metadata'),
    backupType: backupTypeEnum('backup_type').default('file'),
    // Live-progress columns (stall detection + UI progress/speed). Set on
    // every backup_progress WS message and on the async started-ack; NULL
    // means the agent never reported progress (legacy agent).
    lastProgressAt: timestamp('last_progress_at', { withTimezone: true }),
    totalFiles: integer('total_files'),
    // Incremental-backup dedup stats: files/bytes referenced from a prior
    // snapshot instead of re-transferred this run. NULL = agent didn't report
    // dedup (legacy agent, or nothing was referenced).
    referencedSize: bigint('referenced_size', { mode: 'number' }),
    referencedFiles: integer('referenced_files'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('backup_jobs_org_id_idx').on(table.orgId),
    configIdIdx: index('backup_jobs_config_id_idx').on(table.configId),
    policyIdIdx: index('backup_jobs_policy_id_idx').on(table.policyId),
    deviceIdIdx: index('backup_jobs_device_id_idx').on(table.deviceId),
    statusIdx: index('backup_jobs_status_idx').on(table.status),
    startedAtIdx: index('backup_jobs_started_at_idx').on(table.startedAt),
    createdAtIdx: index('backup_jobs_created_at_idx').on(table.createdAt),
  })
);

export const backupSnapshots = pgTable(
  'backup_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    jobId: uuid('job_id')
      .notNull()
      .references(() => backupJobs.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    configId: uuid('config_id').references(() => backupConfigs.id),
    snapshotId: varchar('snapshot_id', { length: 200 }).notNull(),
    label: varchar('label', { length: 200 }),
    location: text('location'),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    size: bigint('size', { mode: 'number' }),
    fileCount: integer('file_count'),
    isIncremental: boolean('is_incremental').notNull().default(false),
    parentSnapshotId: uuid('parent_snapshot_id').references(
      (): AnyPgColumn => backupSnapshots.id
    ),
    expiresAt: timestamp('expires_at'),
    metadata: jsonb('metadata'),
    storageTier: varchar('storage_tier', { length: 30 }),
    isImmutable: boolean('is_immutable').default(false),
    immutableUntil: timestamp('immutable_until'),
    legalHold: boolean('legal_hold').default(false),
    legalHoldReason: text('legal_hold_reason'),
    immutabilityEnforcement: varchar('immutability_enforcement', { length: 20 }),
    requestedImmutabilityEnforcement: varchar('requested_immutability_enforcement', { length: 20 }),
    immutabilityFallbackReason: text('immutability_fallback_reason'),
    encryptionKeyId: uuid('encryption_key_id').references(() => storageEncryptionKeys.id),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    gfsTags: jsonb('gfs_tags'),
    backupType: backupTypeEnum('backup_type').default('file'),
    hardwareProfile: jsonb('hardware_profile'),
    systemStateManifest: jsonb('system_state_manifest'),
  },
  (table) => ({
    orgIdIdx: index('backup_snapshots_org_id_idx').on(table.orgId),
    jobIdIdx: index('backup_snapshots_job_id_idx').on(table.jobId),
    deviceIdIdx: index('backup_snapshots_device_id_idx').on(table.deviceId),
    snapshotIdIdx: index('backup_snapshots_snapshot_id_idx').on(
      table.snapshotId
    ),
    parentSnapshotIdIdx: index('backup_snapshots_parent_snapshot_id_idx').on(
      table.parentSnapshotId
    ),
  })
);

export const backupSnapshotFiles = pgTable(
  'backup_snapshot_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotDbId: uuid('snapshot_db_id')
      .notNull()
      .references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    sourcePath: text('source_path').notNull(),
    backupPath: text('backup_path').notNull(),
    size: bigint('size', { mode: 'number' }),
    modifiedAt: timestamp('modified_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    snapshotIdx: index('backup_snapshot_files_snapshot_idx').on(table.snapshotDbId),
    snapshotSourceIdx: index('backup_snapshot_files_snapshot_source_idx').on(table.snapshotDbId, table.sourcePath),
  })
);

export const restoreJobs = pgTable(
  'restore_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => backupSnapshots.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    restoreType: restoreTypeEnum('restore_type').notNull(),
    targetPath: text('target_path'),
    selectedPaths: jsonb('selected_paths').$type<string[]>().default([]),
    status: backupStatusEnum('status').notNull().default('pending'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    restoredSize: bigint('restored_size', { mode: 'number' }),
    restoredFiles: integer('restored_files'),
    initiatedBy: uuid('initiated_by').references(() => users.id),
    targetConfig: jsonb('target_config'),
    recoveryTokenId: uuid('recovery_token_id'),
    commandId: uuid('command_id').references(() => deviceCommands.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdIdx: index('restore_jobs_org_id_idx').on(table.orgId),
    snapshotIdIdx: index('restore_jobs_snapshot_id_idx').on(table.snapshotId),
    deviceIdIdx: index('restore_jobs_device_id_idx').on(table.deviceId),
    statusIdx: index('restore_jobs_status_idx').on(table.status),
    commandIdIdx: index('restore_jobs_command_id_idx').on(table.commandId),
    recoveryTokenUniqueIdx: uniqueIndex('restore_jobs_recovery_token_id_uniq').on(table.recoveryTokenId),
  })
);
