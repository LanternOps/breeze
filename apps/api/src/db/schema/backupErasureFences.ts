import { bigint, boolean, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Platform evidence written when an organization is erased: what backup
 * storage the org owned, so storage GC keeps treating it as owned after the
 * org's own rows are gone (see services/backupErasureFence.ts and
 * migrations/2026-12-11-100000-backup-erasure-fences.sql).
 *
 * Tenancy: none. Deliberately no org_id column and no foreign key to
 * organizations — the rows outlive the org they describe. Forced RLS, one
 * system-only policy; breeze_app may SELECT/INSERT only (append-only).
 */
export const backupErasureManifests = pgTable('backup_erasure_manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  subjectOrgId: uuid('subject_org_id').notNull(),
  subjectPartnerId: uuid('subject_partner_id'),
  erasureJobId: text('erasure_job_id'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  subjectUq: unique('backup_erasure_manifests_subject_uq').on(table.subjectOrgId),
}));

export const BACKUP_ERASURE_TARGET_KINDS = ['snapshot_prefix', 'recovery_media_key'] as const;
export type BackupErasureTargetKind = (typeof BACKUP_ERASURE_TARGET_KINDS)[number];

export const BACKUP_ERASURE_TARGET_SOURCES = [
  'snapshot', 'retirement', 'reservation', 'recovery_media', 'recovery_boot_media',
] as const;
export type BackupErasureTargetSource = (typeof BACKUP_ERASURE_TARGET_SOURCES)[number];

export const backupErasureTargets = pgTable('backup_erasure_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  manifestId: uuid('manifest_id').notNull().references(() => backupErasureManifests.id),
  subjectOrgId: uuid('subject_org_id').notNull(),
  /** snapshot_prefix | recovery_media_key */
  kind: text('kind').notNull(),
  /** snapshot | retirement | reservation | recovery_media | recovery_boot_media */
  source: text('source').notNull(),
  storageIdentity: text('storage_identity'),
  provider: text('provider'),
  snapshotId: text('snapshot_id'),
  objectKey: text('object_key'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  fileCount: integer('file_count'),
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
  isImmutable: boolean('is_immutable'),
  immutableUntil: timestamp('immutable_until', { withTimezone: true }),
  immutabilityEnforcement: text('immutability_enforcement'),
  /** fenced */
  state: text('state').notNull().default('fenced'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  targetUq: uniqueIndex('backup_erasure_targets_target_uq').on(
    table.kind,
    sql`COALESCE(${table.storageIdentity}, '')`,
    sql`COALESCE(${table.snapshotId}, '')`,
    sql`COALESCE(${table.objectKey}, '')`,
  ),
  snapshotIdx: index('backup_erasure_targets_snapshot_idx').on(table.snapshotId).where(sql`kind = 'snapshot_prefix'`),
  objectKeyIdx: index('backup_erasure_targets_object_key_idx').on(table.objectKey).where(sql`kind = 'recovery_media_key'`),
  subjectIdx: index('backup_erasure_targets_subject_idx').on(table.subjectOrgId),
  manifestIdx: index('backup_erasure_targets_manifest_idx').on(table.manifestId),
}));
