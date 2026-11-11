-- @no-transaction
-- #4342 W3: closed alerts by close time. The closed-alert retention job
-- (jobs/alertRetention.ts) scans `status IN ('resolved', 'dismissed') AND
-- COALESCE(resolved_at, dismissed_at) < cutoff` in LIMITed ctid batches and,
-- report-only, counts the same rows; without this index both are full scans of
-- alerts every night. Built CONCURRENTLY so a busy alerts table is never
-- write-locked during the build. IF NOT EXISTS keeps re-application a no-op.
-- An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state (same
-- pattern as 2027-01-19-110300-alerts-rule-device-subject-closed-idx.sql).
-- Recovery: DROP INDEX CONCURRENTLY public.alerts_closed_age_idx, then let
-- autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_closed_age_idx
  ON public.alerts ((COALESCE(resolved_at, dismissed_at)))
  WHERE status IN ('resolved', 'dismissed');

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.alerts'::regclass
     AND c.relname = 'alerts_closed_age_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'alerts closed-age index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
