-- @no-transaction
-- #4342 W4: per-org age scan for the AI transcript retention job. Every phase
-- (technician stub, client stub, stub delete) and every preview count selects
-- one org's unflagged sessions by last_activity_at. Built CONCURRENTLY so the
-- busy ai_sessions table is never write-locked during the build.
-- IF NOT EXISTS keeps re-application a no-op.
-- An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state (same
-- pattern as 2027-01-19-110300-alerts-rule-device-subject-closed-idx.sql).
-- Recovery: DROP INDEX CONCURRENTLY public.ai_sessions_retention_scan_idx,
-- then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_sessions_retention_scan_idx
  ON public.ai_sessions (org_id, last_activity_at)
  WHERE flagged_at IS NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.ai_sessions'::regclass
     AND c.relname = 'ai_sessions_retention_scan_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ai_sessions retention-scan index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
