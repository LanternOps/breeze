-- @no-transaction
-- #10538 W1: newest closed alert per (rule, device, subject). The alert sweep
-- reads the frozen evidence cursor from that row before re-opening an
-- event-based rule. Built CONCURRENTLY so a busy alerts table is never
-- write-locked during the build. IF NOT EXISTS keeps re-application a no-op.
-- An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state (same
-- pattern as 2026-10-30-130100-partner-api-alerts-feed-index.sql).
-- Recovery: DROP INDEX CONCURRENTLY public.alerts_rule_device_subject_closed_idx,
-- then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_rule_device_subject_closed_idx
  ON public.alerts (rule_id, device_id, (COALESCE(subject_key, '')), (COALESCE(resolved_at, dismissed_at)) DESC)
  WHERE rule_id IS NOT NULL AND status IN ('resolved', 'dismissed');

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.alerts'::regclass
     AND c.relname = 'alerts_rule_device_subject_closed_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'alerts closed-episode index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
