-- @no-transaction
-- Wisp analysis sessions W04 (#11848): org/time indexes for the set-based
-- `export_dataset` datasets. Indexes only: no data change, no tenancy change.
--
-- Each export pages one keyset query per page, newest first across every
-- device in the run's frame: `org_id = $1 AND device_id = ANY($2::uuid[]) AND
-- <time> BETWEEN ... ORDER BY <time> DESC, id DESC LIMIT n`. An index led by
-- (device_id, time) cannot produce that order across many devices, so each page
-- would re-gather and re-sort every remaining row. These lead with org_id and
-- the time column.
--
-- 1. device_boot_metrics_org_boot_idx — boot_performance. A small table, but
--    its rows carry the wide `startup_items` jsonb, which makes a per-page
--    top-N sort expensive.
-- 2. device_hardware_events_org_occurred_idx — hardware_events. The existing
--    occurred_at index is cross-tenant: a sparse org would walk every org's
--    rows.
-- 3. spc_results_org_problem_ts_idx — service_checks, PARTIAL on non-running
--    checks. The table is one row per watch per tick (a planner estimate of
--    about 41M rows is quoted in 2026-07-29-timeseries-retention-brin.sql), so
--    a full index would be very large. v1 exports non-running checks only, and
--    the adapter's predicate is the literal `status <> 'running'` so the
--    planner can prove it implies this index's predicate.
--
-- Not needed: reliability_history / reliability_events use the existing
-- reliability_history_org_collected_idx; reliability_scores pages on the
-- device_reliability primary key.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): these tables are written
-- on agent paths, and a plain CREATE INDEX takes a SHARE lock that blocks
-- every insert for the whole build. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE
-- instead (writes continue). IF NOT EXISTS keeps re-application a no-op. An
-- interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.<name>, then let autoMigrate re-run
-- this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_boot_metrics_org_boot_idx
  ON public.device_boot_metrics (org_id, boot_timestamp DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_hardware_events_org_occurred_idx
  ON public.device_hardware_events (org_id, occurred_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS spc_results_org_problem_ts_idx
  ON public.service_process_check_results (org_id, "timestamp" DESC, id DESC)
  WHERE status <> 'running';

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN (
       'device_boot_metrics_org_boot_idx',
       'device_hardware_events_org_occurred_idx',
       'spc_results_org_problem_ts_idx'
     )
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'export dataset index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
