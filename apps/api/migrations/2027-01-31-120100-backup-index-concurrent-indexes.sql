-- @no-transaction
-- Backup snapshot file index, checkpoint plus delta (#11736 step 2, W2): the index
-- changes, which must not run inside a transaction. Plan:
-- docs/superpowers/plans/backup/2026-11-25-backup-snapshot-index-checkpoint-delta.md
--
--   1. DROP INDEX CONCURRENTLY backup_snapshot_files_snapshot_idx (R8). Its single
--      column (snapshot_db_id) leads backup_snapshot_files_snapshot_source_idx,
--      which keeps serving the FK cascade from backup_snapshots and every reader.
--   2. CREATE INDEX CONCURRENTLY backup_snapshots_file_index_checkpoint_idx, partial
--      on a set pointer (added by 2027-01-31-120000-backup-tree-checkpoints.sql): it
--      serves the ON DELETE RESTRICT check and checkpoint GC's "no snapshot
--      references it" probe. Most rows will never have a pointer.
--
-- Deploy note: each statement waits, without blocking writers, for every open
-- transaction that touches its table. For the first DROP that is
-- backup_snapshot_files, the largest table, including a long file-index hydration.
--
-- Re-runnable after a failure. autoMigrate records this file only once every
-- statement has succeeded, so after any failure the whole file runs again on next
-- start:
--   - A failed DROP INDEX CONCURRENTLY can leave backup_snapshot_files_snapshot_idx
--     behind, INVALID; the same statement completes the drop on the re-run.
--   - A failed CREATE INDEX CONCURRENTLY leaves an INVALID
--     backup_snapshots_file_index_checkpoint_idx, which IF NOT EXISTS would then
--     skip. So that index is dropped first, unconditionally: nothing names it before
--     this file, so dropping and rebuilding it loses nothing, and the build reads
--     only rows with a pointer (none until the writer wave). A re-run therefore
--     drops and rebuilds it; the end state is the same.
-- The final DO block is a backstop: it raises if the index is still INVALID, so the
-- file is never recorded as applied over a broken index.
--
-- No row is written, so no system-scope election is needed.

DROP INDEX CONCURRENTLY IF EXISTS public.backup_snapshot_files_snapshot_idx;

DROP INDEX CONCURRENTLY IF EXISTS public.backup_snapshots_file_index_checkpoint_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS backup_snapshots_file_index_checkpoint_idx
  ON public.backup_snapshots (file_index_checkpoint_id) WHERE file_index_checkpoint_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.backup_snapshots'::regclass
       AND c.relname = 'backup_snapshots_file_index_checkpoint_idx'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'backup_snapshots_file_index_checkpoint_idx is INVALID after its build; the next start re-runs this file, which drops and rebuilds it';
  END IF;
END $$;
