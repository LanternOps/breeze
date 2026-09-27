import { boolean, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { deviceCommands, devices } from './devices';
import { backupConfigs, backupSnapshots } from './backup';

/**
 * Short-lived, read-only storage sessions delivered to restore-shaped backup
 * commands in place of the reusable storage destination (see
 * services/backupStorageSessions.ts and
 * migrations/2026-11-05-100600-backup-storage-sessions.sql).
 *
 * Tenancy: direct org_id (shape 1), denormalised from the EXECUTING device
 * (`device_id`). `source_device_id` is the snapshot's own device, which may
 * differ for a cross-device restore. Only a SHA-256 of the token is stored.
 */
export const backupStorageSessions = pgTable(
  'backup_storage_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    commandId: uuid('command_id').notNull().references(() => deviceCommands.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    sourceDeviceId: uuid('source_device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id').notNull().references(() => backupSnapshots.id, { onDelete: 'cascade' }),
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
  },
  (table) => ({
    tokenHashUq: uniqueIndex('backup_storage_sessions_token_hash_uq').on(table.tokenHash),
    commandGenerationUq: uniqueIndex('backup_storage_sessions_command_generation_uq').on(table.commandId, table.generation),
    orgIdx: index('backup_storage_sessions_org_idx').on(table.orgId),
    deviceIdx: index('backup_storage_sessions_device_idx').on(table.deviceId),
    sourceDeviceIdx: index('backup_storage_sessions_source_device_idx').on(table.sourceDeviceId),
    snapshotIdx: index('backup_storage_sessions_snapshot_idx').on(table.snapshotId),
    configIdx: index('backup_storage_sessions_config_idx').on(table.configId),
  }),
);
