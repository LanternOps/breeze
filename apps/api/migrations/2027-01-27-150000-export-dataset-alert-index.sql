-- @no-transaction
-- Wisp analysis sessions W05 (#11849): org/time index for the set-based
-- `alerts` export dataset. Index only: no data change, no tenancy change.
--
-- The export pages one keyset query per page, newest first across every
-- device in the run's frame: `org_id = $1 AND owner_kind = 'device' AND
-- device_id = ANY($2::uuid[]) AND triggered_at BETWEEN ... ORDER BY
-- triggered_at DESC, id DESC LIMIT n`. The existing indexes cannot give that
-- order across a frame: alerts_device_triggered_at_idx leads on device_id, and
-- alerts_org_status_triggered_at_idx puts status before triggered_at
-- (2026-05-17-b-alerts-scale-indexes.sql), so every page would re-gather and
-- re-sort the remaining rows. This one leads with org_id and the time column.
--
-- PARTIAL on device-owned alerts: the export reads only those (topology-site
-- and backup-workload alerts are skipped), and the adapter's predicate is the
-- literal `owner_kind = 'device'` so the planner can prove it implies this
-- index's predicate.
--
-- Not needed: patch_state pages on device_patches_device_patch_unique,
-- change_log on device_change_log_org_time_idx, and patch_attempts on
-- patch_job_results_created_idx (the table has no org_id column).
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): alerts is written on
-- agent and evaluator paths, and a plain CREATE INDEX takes a SHARE lock that
-- blocks every insert for the whole build. CONCURRENTLY takes SHARE UPDATE
-- EXCLUSIVE instead (writes continue). IF NOT EXISTS keeps re-application a
-- no-op. An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT
-- EXISTS would silently accept, so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.alerts_org_device_triggered_idx,
-- then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_org_device_triggered_idx
  ON public.alerts (org_id, triggered_at DESC, id DESC)
  WHERE owner_kind = 'device';

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = 'alerts_org_device_triggered_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'export dataset index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
