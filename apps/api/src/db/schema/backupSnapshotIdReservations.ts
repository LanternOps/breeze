import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { devices } from './devices';
import { backupConfigs, backupJobs, backupSnapshots } from './backup';

/**
 * One owner per backup snapshot id, keyed by the id alone — independent of
 * storage destination, endpoint spelling and organization (see
 * services/backupSnapshotIdReservations.ts and
 * migrations/2026-11-08-120000-backup-snapshot-id-reservations.sql).
 *
 * Tenancy: direct org_id (shape 1) with device_id, so a device move restamps
 * it. Deleting a row writes a tombstone for its id (trigger), so an id is
 * never handed out twice.
 */
export const backupSnapshotIdReservations = pgTable(
  'backup_snapshot_id_reservations',
  {
    snapshotId: text('snapshot_id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    configId: uuid('config_id').references(() => backupConfigs.id, { onDelete: 'set null' }),
    storageIdentity: text('storage_identity'),
    /** server_minted | legacy_published | legacy_job | reconcile */
    source: text('source').notNull(),
    /** reserved | sealing | published | retired | abandoned */
    state: text('state').notNull(),
    currentJobId: uuid('current_job_id').references(() => backupJobs.id, { onDelete: 'set null' }),
    writeGeneration: integer('write_generation').notNull().default(1),
    sealedUntil: timestamp('sealed_until', { withTimezone: true }),
    publishedSnapshotDbId: uuid('published_snapshot_db_id').references(() => backupSnapshots.id, { onDelete: 'set null' }),
    /** When the cleanup job last aborted every stray multipart upload under the prefix. */
    uploadsSweptAt: timestamp('uploads_swept_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('backup_snapshot_id_reservations_org_idx').on(table.orgId),
    deviceIdx: index('backup_snapshot_id_reservations_device_idx').on(table.deviceId),
    configIdx: index('backup_snapshot_id_reservations_config_idx').on(table.configId),
    jobIdx: index('backup_snapshot_id_reservations_job_idx').on(table.currentJobId),
    publishedIdx: index('backup_snapshot_id_reservations_published_idx').on(table.publishedSnapshotDbId),
    activeIdx: index('backup_snapshot_id_reservations_active_idx')
      .on(table.state)
      .where(sql`state IN ('reserved', 'sealing', 'abandoned')`),
  }),
);

/**
 * Snapshot ids that may never be issued or accepted again. Not tenant-scoped:
 * id, reason and timestamp only. System context only (forced RLS, one
 * system-scope policy); the app role may read and append, never rewrite.
 */
export const backupSnapshotIdTombstones = pgTable('backup_snapshot_id_tombstones', {
  snapshotId: text('snapshot_id').primaryKey(),
  /** reservation_deleted | retired | legacy_duplicate | abandoned_reclaimed */
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
