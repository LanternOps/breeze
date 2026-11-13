-- @no-transaction
-- #4342 W1 (#11588): indexes for the report-first device telemetry retention
-- jobs (jobs/deviceCommandRetention.ts, networkMonitorResultRetention.ts,
-- deviceSessionRetention.ts). Indexes only: no data change, no tenancy change.
--
-- 1. idx_device_commands_terminal_age — the age scan over terminal commands.
--    Its predicate is the job's status list verbatim, so the planner can prove
--    the job's WHERE implies it.
-- 2. idx_device_commands_keep_newest — the per-device "is there a newer row of
--    this type?" probe behind KEEP_NEWEST_COMMAND_READERS. set_log_level's
--    completed_at ordering is already served by
--    idx_device_commands_set_log_level_device_completed.
-- 3. network_monitor_results_monitor_ts_idx — the per-monitor newer-result probe.
-- 4. device_sessions_closed_age_idx — the age scan over closed sessions.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): device_commands and
-- network_monitor_results are written on the agent / monitor hot path, and a
-- plain CREATE INDEX takes a SHARE lock that blocks every insert and update
-- for the whole build. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE instead
-- (writes continue) and waits for transactions already open on the table.
-- IF NOT EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY
-- build leaves an INVALID index that IF NOT EXISTS would silently accept, so
-- the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.<name>, then let autoMigrate re-run
-- this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_terminal_age
  ON public.device_commands ((COALESCE(completed_at, created_at)))
  WHERE status IN ('completed', 'failed', 'timeout', 'cancelled');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_keep_newest
  ON public.device_commands (device_id, type, created_at DESC)
  WHERE type IN ('patch_scan', 'set_log_level', 'self_uninstall', 'oem_update_run', 'oem_update_release');

CREATE INDEX CONCURRENTLY IF NOT EXISTS network_monitor_results_monitor_ts_idx
  ON public.network_monitor_results (monitor_id, "timestamp" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_sessions_closed_age_idx
  ON public.device_sessions ((COALESCE(logout_at, updated_at)))
  WHERE is_active = false;

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
       'idx_device_commands_terminal_age',
       'idx_device_commands_keep_newest',
       'network_monitor_results_monitor_ts_idx',
       'device_sessions_closed_age_idx'
     )
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'retention W1 index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
