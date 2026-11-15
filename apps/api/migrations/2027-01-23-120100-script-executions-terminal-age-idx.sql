-- @no-transaction
-- #4342 W2: age scan for the script execution retention job. Both the output
-- scrub and the row delete select terminal executions by
-- COALESCE(completed_at, created_at); without this index each nightly count
-- and each ctid batch would scan the whole table. Built CONCURRENTLY so the
-- busy script_executions table is never write-locked during the build.
-- IF NOT EXISTS keeps re-application a no-op.
-- An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state (same
-- pattern as 2027-01-19-110300-alerts-rule-device-subject-closed-idx.sql).
-- Recovery: DROP INDEX CONCURRENTLY public.script_executions_terminal_age_idx,
-- then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS script_executions_terminal_age_idx
  ON public.script_executions ((COALESCE(completed_at, created_at)))
  WHERE status IN ('completed', 'failed', 'timeout', 'cancelled');

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.script_executions'::regclass
     AND c.relname = 'script_executions_terminal_age_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'script_executions terminal-age index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
