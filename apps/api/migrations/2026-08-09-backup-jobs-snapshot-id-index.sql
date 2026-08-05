-- #3006 — index backup_jobs.snapshot_id.
--
-- Two new access patterns key on this column and neither had an index:
--
--   1. Mid-run snapshot registration (services/backupProgress.ts) now writes
--      snapshot_id while a backup is still uploading, so the column is no
--      longer a write-once field set only at completion.
--   2. Orphaned-snapshot reconcile (services/backupSnapshotReconcile.ts) looks
--      up `snapshot_id IN (...)` for every manifest found in a destination, in
--      a SYSTEM db context — i.e. across every tenant's rows — to determine
--      whether a snapshot is already claimed. Unindexed, that is a full
--      sequential scan of backup_jobs per batch of 500 ids, and getting the
--      answer wrong is a cross-tenant adoption, so it is not optional work.
--
-- Partial (`WHERE snapshot_id IS NOT NULL`) because the overwhelming majority
-- of rows carry no snapshot id and the lookups only ever probe non-null values.
--
-- No new table and no new column: backup_jobs.snapshot_id already exists, so
-- this migration adds no RLS, cascade-list, or export-policy obligations. An
-- index-only migration introduces no column for CORE_TENANT_EXPORT_POLICY to
-- classify, which is the one registration that fires on a new COLUMN rather
-- than a new table.
--
-- Dated 2026-08-09 deliberately: the 2026-08-06 block is RESERVED for the
-- security remediation waves and autoMigrate.test.ts pins it to slots a-f
-- (RESERVED_SLOT_PATTERN). A `-g-` slot there fails that guard and takes three
-- ordering tests down with it. This migration has no ordering dependency on
-- anything in that block — it only indexes an existing column.

CREATE INDEX IF NOT EXISTS backup_jobs_snapshot_id_idx
  ON backup_jobs (snapshot_id)
  WHERE snapshot_id IS NOT NULL;
