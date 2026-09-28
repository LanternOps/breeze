import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { deviceCommands, devices } from './devices';
import { backupConfigs, backupJobs, backupSnapshots } from './backup';
import { backupSnapshotIdReservations } from './backupSnapshotIdReservations';

/**
 * Short-lived storage sessions delivered to backup commands in place of the
 * reusable storage destination: read-scoped for restore-shaped commands
 * (services/backupStorageSessions.ts, 2026-11-05-100600) and write-scoped for
 * backups (services/backupStorageWriteSessions.ts, 2026-11-08-120100).
 *
 * Tenancy: direct org_id (shape 1), denormalised from the EXECUTING device
 * (`device_id`). `source_device_id` is the snapshot's own device, which may
 * differ for a cross-device restore (the executing device for a write).
 * Only a SHA-256 of the token is stored. A read session names its command and
 * snapshot; a write session names its backup job and its snapshot id
 * reservation instead (backup_storage_sessions_shape_chk).
 */
export const backupStorageSessions = pgTable(
  'backup_storage_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    commandId: uuid('command_id').references(() => deviceCommands.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id').references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    configId: uuid('config_id').notNull().references(() => backupConfigs.id, { onDelete: 'cascade' }),
    storageIdentity: text('storage_identity').notNull(),
    scope: text('scope').notNull().default('snapshot_read'),
    controlKeys: text('control_keys').array().notNull().default([]),
    useFileIndex: boolean('use_file_index').notNull(),
    tokenHash: text('token_hash').notNull(),
    generation: integer('generation').notNull(),
    maxCalls: integer('max_calls').notNull(),
    maxResolvedObjects: integer('max_resolved_objects').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    resolvedObjectCount: integer('resolved_object_count').notNull().default(0),
    callCount: integer('call_count').notNull().default(0),
    // Rate buckets (services/backupStorageSessions.ts, evaluateStorageSessionBudget):
    // what each bucket held at rate_refilled_at; they refill continuously.
    rateCallsAvailable: doublePrecision('rate_calls_available').notNull(),
    rateObjectsAvailable: doublePrecision('rate_objects_available').notNull(),
    rateRefilledAt: timestamp('rate_refilled_at', { withTimezone: true }).notNull(),
    // Write scope only (NULL / defaults for a read session).
    jobId: uuid('job_id').references(() => backupJobs.id, { onDelete: 'cascade' }),
    reservationSnapshotId: text('reservation_snapshot_id').references(
      () => backupSnapshotIdReservations.snapshotId,
      { onDelete: 'cascade' },
    ),
    reservationGeneration: integer('reservation_generation'),
    /** Latest expiry of any upload URL this session issued (monotonic). */
    urlHorizonAt: timestamp('url_horizon_at', { withTimezone: true }),
    /** Whether this session's single-object uploads carry a create-only condition. */
    conditionalWrites: boolean('conditional_writes').notNull().default(false),
    /** Set after resuming onto an already-published snapshot id: reads of that prefix only. */
    readOnly: boolean('read_only').notNull().default(false),
    resumedAt: timestamp('resumed_at', { withTimezone: true }),
  },
  (table) => ({
    tokenHashUq: uniqueIndex('backup_storage_sessions_token_hash_uq').on(table.tokenHash),
    commandGenerationUq: uniqueIndex('backup_storage_sessions_command_generation_uq').on(table.commandId, table.generation),
    orgIdx: index('backup_storage_sessions_org_idx').on(table.orgId),
    deviceIdx: index('backup_storage_sessions_device_idx').on(table.deviceId),
    sourceDeviceIdx: index('backup_storage_sessions_source_device_idx').on(table.sourceDeviceId),
    snapshotIdx: index('backup_storage_sessions_snapshot_idx').on(table.snapshotId),
    configIdx: index('backup_storage_sessions_config_idx').on(table.configId),
    jobGenerationUq: uniqueIndex('backup_storage_sessions_job_generation_uq')
      .on(table.jobId, table.generation)
      .where(sql`job_id IS NOT NULL`),
    reservationIdx: index('backup_storage_sessions_reservation_idx').on(table.reservationSnapshotId),
  }),
);

/**
 * Multipart uploads created through a write session, kept so an abort is
 * durable after the session, job or process is gone (jobs/
 * backupWriteSessionJanitor.ts). Tenancy: direct org_id with device_id.
 */
export const backupStorageSessionUploads = pgTable(
  'backup_storage_session_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => backupStorageSessions.id, { onDelete: 'cascade' }),
    reservationSnapshotId: text('reservation_snapshot_id').notNull(),
    reservationGeneration: integer('reservation_generation').notNull(),
    objectKey: text('object_key').notNull(),
    uploadId: text('upload_id'),
    /** creating | open | completing | completed | aborted */
    state: text('state').notNull().default('creating'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    keyUploadUq: uniqueIndex('backup_storage_session_uploads_key_upload_uq')
      .on(table.objectKey, table.uploadId)
      .where(sql`upload_id IS NOT NULL`),
    orgIdx: index('backup_storage_session_uploads_org_idx').on(table.orgId),
    deviceIdx: index('backup_storage_session_uploads_device_idx').on(table.deviceId),
    sessionIdx: index('backup_storage_session_uploads_session_idx').on(table.sessionId),
    reservationIdx: index('backup_storage_session_uploads_reservation_idx').on(table.reservationSnapshotId),
    openIdx: index('backup_storage_session_uploads_open_idx')
      .on(table.state)
      .where(sql`state IN ('creating', 'open', 'completing')`),
  }),
);
