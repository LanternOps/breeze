-- backup_snapshot_files.kind: what a content-less index row is (#11235).
--
-- A manifest entry that uploads nothing (backup_path '') is a directory the
-- agent recorded (empty, non-default mode/owner, a Windows folder with
-- preserved attributes or a captured security descriptor, or a
-- pattern-excluded placeholder) or a symlink: agent/internal/backup/snapshot.go
-- SnapshotFile.Kind. The server-built (hydrated) index used to drop them while
-- the agent's inline rows kept them, so one snapshot listed two trees. Both
-- writers now keep them and record which they are here, so browse can show a
-- directory entry as a folder and search can return it as one.
--
--   NULL       a regular file whose bytes live at backup_path, or a
--              content-less row written before this column (kind unknown)
--   'dir'      a directory entry; backup_path is ''
--   'symlink'  a symbolic link; backup_path is ''
--
-- ADD COLUMN without a default is metadata-only. The CHECK is NOT VALID and
-- left that way: every existing row is NULL, which it allows, and validating
-- would scan a table that can hold millions of rows during API boot. New and
-- updated rows are checked either way. No RLS change: the table keeps its
-- snapshot-keyed policies, and the new column is covered by them.
--
-- Idempotent. Writes no rows.

ALTER TABLE public.backup_snapshot_files ADD COLUMN IF NOT EXISTS kind text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'backup_snapshot_files_kind_chk'
       AND conrelid = 'public.backup_snapshot_files'::regclass
  ) THEN
    ALTER TABLE public.backup_snapshot_files
      ADD CONSTRAINT backup_snapshot_files_kind_chk
      CHECK (kind IS NULL OR (kind IN ('dir', 'symlink') AND backup_path = '')) NOT VALID;
  END IF;
END $$;
