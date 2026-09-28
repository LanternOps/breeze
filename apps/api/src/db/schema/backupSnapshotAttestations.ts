import { bigint, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { devices } from './devices';
import { backupJobs, backupSnapshots } from './backup';

/**
 * One snapshot attestation per snapshot (see services/backupAttestation.ts and
 * migrations/2026-11-08-110000-backup-snapshot-attestations.sql).
 *
 * The producing device reports a canonical statement over the exact bytes of
 * the snapshot's control objects (manifest, layout manifest, system-state
 * manifest) with its authenticated backup result. The API binds it to its own
 * records, stores the statement verbatim (`statement_sha256` is over those
 * bytes) and, for destinations it can read, fetches the objects itself and
 * moves the row from `pending` to `verified` or `mismatch` exactly once.
 * Device-local destinations are recorded as `producer_only`.
 *
 * Every column except `org_id`, `status`, `verify_error` and `verified_at` is
 * immutable (trigger); `status` only moves `pending -> verified | mismatch`.
 * `signature_alg`/`signature` are reserved for device-side signing and are
 * NULL in statement format 1.
 *
 * Tenancy: direct org_id (shape 1), denormalised from the device, restamped
 * by the device-move trigger like every other device_id + org_id table.
 */
export const backupSnapshotAttestations = pgTable(
  'backup_snapshot_attestations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    snapshotDbId: uuid('snapshot_db_id').notNull().references(() => backupSnapshots.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull().references(() => backupJobs.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    providerSnapshotId: text('provider_snapshot_id').notNull(),
    storageIdentity: text('storage_identity').notNull(),
    keyLayout: text('key_layout').notNull(),
    // The incremental base the server pinned in the dispatched command; NULL
    // for a full dispatch.
    dispatchedBaseProviderSnapshotId: text('dispatched_base_provider_snapshot_id'),
    // The base the run actually used; NULL when the run was full (including a
    // full run that fell back from a dispatched base).
    parentProviderSnapshotId: text('parent_provider_snapshot_id'),
    verificationMode: text('verification_mode').notNull(),
    acceptedVia: text('accepted_via').notNull(),
    resultReceivedAt: timestamp('result_received_at', { withTimezone: true }).notNull(),
    formatVersion: integer('format_version').notNull(),
    statement: text('statement').notNull(),
    statementSha256: text('statement_sha256').notNull(),
    manifestKey: text('manifest_key').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    manifestSize: bigint('manifest_size', { mode: 'number' }).notNull(),
    layoutSha256: text('layout_sha256'),
    layoutSize: bigint('layout_size', { mode: 'number' }),
    systemStateManifestSha256: text('system_state_manifest_sha256'),
    systemStateManifestSize: bigint('system_state_manifest_size', { mode: 'number' }),
    signatureAlg: text('signature_alg'),
    signature: text('signature'),
    status: text('status').notNull().default('pending'),
    verifyError: text('verify_error'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    snapshotUq: uniqueIndex('backup_snapshot_attestations_snapshot_uq').on(table.snapshotDbId),
    orgIdx: index('backup_snapshot_attestations_org_idx').on(table.orgId),
    deviceIdx: index('backup_snapshot_attestations_device_idx').on(table.deviceId),
    jobIdx: index('backup_snapshot_attestations_job_idx').on(table.jobId),
    pendingIdx: index('backup_snapshot_attestations_pending_idx')
      .on(table.createdAt)
      .where(sql`status = 'pending'`),
  }),
);

export type BackupSnapshotAttestationStatus = 'pending' | 'verified' | 'mismatch' | 'producer_only';

/** Projection on backup_snapshots.integrity_status (display and reports). */
export type BackupSnapshotIntegrityStatus =
  | 'unattested_legacy'
  | 'unattested'
  | 'pending'
  | 'attested'
  | 'producer_only'
  | 'attestation_failed';

/** How a backup_snapshots row came to exist (backup_snapshots.result_provenance). */
export type BackupSnapshotResultProvenance = 'agent_result' | 'reconcile' | 'agent_result_after_reconcile';
