-- backup_snapshot_files: let the file-index hydrator refresh planner
-- statistics right after a large publish (#11209).
--
-- WHY
-- ---
-- A hydration publish writes every file row of a snapshot in one transaction.
-- Until the table is next analyzed the planner still describes it as it was
-- before. Measured on a test stack at 1.1M new rows (#11209): it estimated
-- about 1,300 rows for a selection page and 3,800 for the browse aggregate.
-- Each selection page then bitmap-scanned and sorted every remaining row of
-- the snapshot instead of reading one range of
-- backup_snapshot_files_snapshot_source_idx (510 ms a page against 5.5 ms),
-- and a folder selection took 39–44 s until autovacuum analyzed the table.
-- The API connects as breeze_app, which does not own the table: a plain
-- ANALYZE from it is skipped with a warning.
--
-- WHAT
-- ----
-- public.breeze_analyze_backup_snapshot_files(): SECURITY DEFINER, owned by
-- the role that runs migrations (the table's owner). PUBLIC may not execute
-- it; breeze_app may, when that role exists. It analyzes this one table and
-- nothing else, so the grant cannot be turned on any other relation. It takes
-- the table's SHARE UPDATE EXCLUSIVE lock with NOWAIT first and returns false
-- if any conflicting lock is held (another ANALYZE or a VACUUM, autovacuum's
-- included, or DDL): the caller never queues behind, or cancels, autovacuum.
-- It returns true once the table has been analyzed. The lock does not block
-- reads or writes and is held until the caller's transaction ends. The caller
-- bounds the run with statement_timeout and retries a busy table a few times
-- (backupSnapshotFileIndexStatistics.ts).
--
-- A table owned by some other role (a hand-built install) would make ANALYZE
-- skip with only a warning; the function raises instead, so the hydrator logs
-- it rather than reporting a refresh that did not happen.
--
-- Idempotent: CREATE OR REPLACE, then REVOKE/GRANT. No inner BEGIN/COMMIT. No
-- rows written, so no breeze.scope election.

CREATE OR REPLACE FUNCTION public.breeze_analyze_backup_snapshot_files()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.backup_snapshot_files'::regclass
      AND pg_has_role(current_user, c.relowner, 'USAGE')
  ) THEN
    RAISE EXCEPTION 'breeze_analyze_backup_snapshot_files: % does not own backup_snapshot_files', current_user
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    LOCK TABLE public.backup_snapshot_files IN SHARE UPDATE EXCLUSIVE MODE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN FALSE;
  END;

  ANALYZE public.backup_snapshot_files;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_analyze_backup_snapshot_files() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_analyze_backup_snapshot_files() TO breeze_app;
  END IF;
END $$;
