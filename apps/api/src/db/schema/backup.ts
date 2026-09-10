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
import { BACKUP_SNAPSHOT_ID_MAX_LENGTH } from './backupConstants';
import {
  recoveryAuthorizationSubjectChecks,
  recoveryAuthorizationSubjectColumns,
} from './recoveryAuthorizationSubject';

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
 * The terminal `backup_status` values that left behind a usable restore point.
 *
 * `partial` belongs here (#3000). A partial run lost a disproportionate share
 * of its data — which is why it is not `completed` and why it raises a
 * dashboard attention item — but it DID produce a real, restorable snapshot
 * with a backup_snapshots row. Anything asking "does this device have a recent
 * restore point?" (RPO/SLA, recovery readiness, verification eligibility,
 * last-successful-backup reporting) must therefore count it.
 *
 * The distinction matters most in the negative: excluding `partial` here would
 * make the SLA worker raise `missed_backup` — whose text asserts that no
 * successful backup completed in the window — for a device that demonstrably
 * has a snapshot, AND leave that breach permanently unresolvable, because
 * breach auto-resolution keys on the very same query. Use the job's own status
 * (or attentionItems) to express "degraded"; do not express it by pretending
 * no backup exists.
 */
export const RESTORABLE_BACKUP_JOB_STATUSES = ['completed', 'partial'] as const;

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

export { BACKUP_SNAPSHOT_ID_MAX_LENGTH } from './backupConstants';

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
    /**
     * Bumped on every PATCH (site-ceiling gate contract §3). Snapshotted onto
     * the queued job / backup_jobs row at schedule time and compared at
     * dispatch by backupWorker; mismatch fails the job closed
     * (`backup_config_changed`) instead of dispatching against a
     * since-edited destination, and the scheduler re-enqueues against the
     * new generation.
     */
    approvalGeneration: integer('approval_generation').notNull().default(1),
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
    snapshotId: varchar('snapshot_id', { length: BACKUP_SNAPSHOT_ID_MAX_LENGTH }),
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
    // D18 W01 (#5429/§3.1): server-chosen incremental-dedupe base for this
    // run. Deliberately NOT a FK — a pin must survive independent of the base
    // row's own lifecycle; retention checks this column directly.
    baseSnapshotId: varchar('base_snapshot_id', { length: 255 }),
    // Fixed publish deadline, set once at dispatch for EVERY dispatched
    // file/system_image job (base or not) — never renewed (no delivery
    // channel exists to renew it on progress). A pin is live while
    // status IN ('pending','running') OR
    // publish_lease_expires_at + BACKUP_PUBLISH_MARGIN_MS > now().
    publishLeaseExpiresAt: timestamp('publish_lease_expires_at', { withTimezone: true }),
    // D18 W01 (#5429/§3.6): the identity of the providerConfig actually
    // placed in the DISPATCH payload — stamped once, at dispatch, regardless
    // of whether a base was found. Copied onto backup_snapshots.storageIdentity
    // at publication so GC groups by write-time identity, not the config's
    // possibly-since-edited current one.
    storageIdentity: text('storage_identity'),
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
    // #3006: probed by the mid-run registration path and by the cross-tenant
    // claim lookup in backupSnapshotReconcile. Partial index — see
    // migrations/2026-08-09-backup-jobs-snapshot-id-index.sql.
    snapshotIdIdx: index('backup_jobs_snapshot_id_idx')
      .on(table.snapshotId)
      .where(sql`snapshot_id IS NOT NULL`),
    createdAtIdx: index('backup_jobs_created_at_idx').on(table.createdAt),
    // D18 W01 (#5429/§3.1): matches migration 160011's
    // backup_jobs_base_snapshot_id_idx.
    baseSnapshotIdIdx: index('backup_jobs_base_snapshot_id_idx')
      .on(table.baseSnapshotId)
      .where(sql`base_snapshot_id IS NOT NULL`),
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
    snapshotId: varchar('snapshot_id', { length: BACKUP_SNAPSHOT_ID_MAX_LENGTH }).notNull(),
    label: varchar('label', { length: 200 }),
    location: text('location'),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    size: bigint('size', { mode: 'number' }),
    fileCount: integer('file_count'),
    isIncremental: boolean('is_incremental').notNull().default(false),
    // ON DELETE SET NULL (2026-10-15-140004): an incremental snapshot's
    // parent pointer must not block the parent's own retention deletion —
    // see the migration and deleteSnapshotRow's comment above for the D17
    // history/lineage rationale.
    parentSnapshotId: uuid('parent_snapshot_id').references(
      (): AnyPgColumn => backupSnapshots.id,
      { onDelete: 'set null' }
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
    // D18 W01 (#5429/§3.6): copied from the owning job's storageIdentity at
    // publication (or by reconcile from the adoptable job). Nullable FOREVER
    // — the W02 sweep self-heals a NULL row from the storage listing; there
    // is no follow-up NOT NULL migration.
    storageIdentity: text('storage_identity'),
    // Bare-metal recovery (W01): disk layout captured at run time and the
    // guard verdict. NULL verdict = not assessed (file-only run / old agent).
    layoutManifest: jsonb('layout_manifest'),
    bareMetalRestorable: boolean('bare_metal_restorable'),
    bareMetalReasons: text('bare_metal_reasons').array(),
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

export const backupSnapshotRetirementReasonEnum = pgEnum('backup_snapshot_retirement_reason', [
  'expired',
  'max_versions',
  'manual',
]);

// D18 W01 (#5429/§3.3): a durable tombstone written the instant retention
// deletes a backup_snapshots row. Age alone cannot distinguish "expired" from
// "orphan" and cannot stop reconcile re-adopting an expired prefix mid-sweep
// — see the design doc's "why" note. Shape 1 (plain org_id) tenancy.
export const backupSnapshotRetirements = pgTable(
  'backup_snapshot_retirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    configId: uuid('config_id').references(() => backupConfigs.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    snapshotId: varchar('snapshot_id', { length: BACKUP_SNAPSHOT_ID_MAX_LENGTH }).notNull(),
    storageIdentity: text('storage_identity').notNull(),
    backupType: backupTypeEnum('backup_type'),
    reason: backupSnapshotRetirementReasonEnum('reason').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }).defaultNow().notNull(),
    // Set by the GC sweep (W02) once the prefix is confirmed empty. NULL =
    // not yet swept. Rows are pruned 30d after this is set.
    sweptAt: timestamp('swept_at', { withTimezone: true }),
  },
  (table) => ({
    orgIdIdx: index('backup_snapshot_retirements_org_id_idx').on(table.orgId),
    storageIdentitySnapshotUq: uniqueIndex('backup_snapshot_retirements_identity_snapshot_uq').on(
      table.storageIdentity,
      table.snapshotId
    ),
    identitySweptIdx: index('backup_snapshot_retirements_identity_swept_idx').on(
      table.storageIdentity,
      table.sweptAt
    ),
  })
);

export const restoreJobs = pgTable(
  'restore_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    // Nullable + ON DELETE SET NULL (2026-10-15-140004): a restore job is
    // history and must survive its snapshot's retention deletion — see D17 /
    // deleteSnapshotRow's comment on backup_snapshots above.
    snapshotId: uuid('snapshot_id').references(() => backupSnapshots.id, {
      onDelete: 'set null',
    }),
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
    commandId: uuid('command_id').references(() => deviceCommands.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    ...recoveryAuthorizationSubjectColumns(),
  },
  (table) => ({
    orgIdIdx: index('restore_jobs_org_id_idx').on(table.orgId),
    snapshotIdIdx: index('restore_jobs_snapshot_id_idx').on(table.snapshotId),
    deviceIdIdx: index('restore_jobs_device_id_idx').on(table.deviceId),
    statusIdx: index('restore_jobs_status_idx').on(table.status),
    authorizationClaimIdx: index('restore_jobs_authorization_claim_idx')
      .on(table.status, table.authorizationState)
      .where(sql`${table.status} IN ('pending', 'running')`),
    commandIdIdx: index('restore_jobs_command_id_idx').on(table.commandId),
    recoveryTokenUniqueIdx: uniqueIndex('restore_jobs_recovery_token_id_uniq').on(table.recoveryTokenId),
    ...recoveryAuthorizationSubjectChecks('restore_jobs', table),
  })
);
