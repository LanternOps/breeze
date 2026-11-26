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
--      references it" probe. Nearly every row has no pointer.
--
-- Deploy note: each statement waits, without blocking writers, for every open
-- transaction that touches its table. For the DROP that is backup_snapshot_files,
-- the largest table, including a long file-index hydration.
--
-- Idempotent: IF [NOT] EXISTS on both statements. A failed CONCURRENTLY build
-- leaves an INVALID index that IF NOT EXISTS would then skip, so the final DO block
-- raises instead of letting the file be recorded as applied; an operator must DROP
-- INDEX CONCURRENTLY it and restart (same contract as
-- 2026-12-17-100300-time-entries-contract-line.sql).
--
-- No row is written, so no system-scope election is needed.

DROP INDEX CONCURRENTLY IF EXISTS public.backup_snapshot_files_snapshot_idx;

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
    RAISE EXCEPTION 'backup_snapshots_file_index_checkpoint_idx build left an INVALID index — DROP INDEX CONCURRENTLY it and re-apply this migration';
  END IF;
END $$;
