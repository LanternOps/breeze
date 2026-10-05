import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { devices } from './devices';
import { backupSnapshots } from './backup';
import { users } from './users';
import { recoveryTokens } from './recoveryTokens';
import { bareMetalRecoveries } from './bareMetalRecoveries';

/**
 * A technician's confirmed authorization to restore one snapshot that has no
 * usable attestation (unattested, or device-local restored onto another
 * device) onto one target device with one command type
 * (services/backupRestoreAuthorization.ts,
 * migrations/2026-12-13-100000-backup-restore-authorizations.sql).
 *
 * Created only after a two-factor step-up grant bound to exactly that tuple
 * was consumed, in the same transaction as its audit event. Bound to exactly
 * one thing that performs the restore: a device command (by its reserved id),
 * a recovery token, or a bare-metal recovery. Delivery and recovery
 * authentication trust this row, never a marker in a command payload.
 *
 * Immutable except org_id (device move, org merge). Tenancy: direct org_id
 * (shape 1) with device_id = the restore target, restamped by the device-move
 * trigger like every other device_id + org_id table.
 */
export const backupRestoreAuthorizations = pgTable(
  'backup_restore_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    snapshotDbId: uuid('snapshot_db_id').notNull().references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    commandType: text('command_type').notNull(),
    reason: text('reason').notNull(),
    authorizedByUserId: uuid('authorized_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The step-up resource digest the grant was bound to (sha256:<hex>), for the record. */
    resourceDigest: text('resource_digest').notNull(),
    /** Reserved device_commands id (no FK: reserved before the command row exists). */
    commandId: uuid('command_id'),
    recoveryTokenId: uuid('recovery_token_id').references(() => recoveryTokens.id, { onDelete: 'cascade' }),
    recoveryId: uuid('recovery_id').references(() => bareMetalRecoveries.id, { onDelete: 'cascade' }),
    auditWrittenAt: timestamp('audit_written_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    commandUq: uniqueIndex('backup_restore_authorizations_command_uq')
      .on(table.commandId)
      .where(sql`command_id IS NOT NULL`),
    tokenIdx: index('backup_restore_authorizations_token_idx').on(table.recoveryTokenId),
    recoveryIdx: index('backup_restore_authorizations_recovery_idx').on(table.recoveryId),
    orgIdx: index('backup_restore_authorizations_org_idx').on(table.orgId),
    deviceIdx: index('backup_restore_authorizations_device_idx').on(table.deviceId),
    snapshotIdx: index('backup_restore_authorizations_snapshot_idx').on(table.snapshotDbId),
  }),
);

export type BackupRestoreAuthorizationReason = 'unattested_legacy' | 'unattested' | 'producer_only_other_target';
