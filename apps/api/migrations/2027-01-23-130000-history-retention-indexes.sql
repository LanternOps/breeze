-- @no-transaction
-- #4342 W5 (#11592): indexes for the report-first history retention job
-- (jobs/historyRetention/). Indexes only: no data change, no tenancy change.
--
-- Each serves one target's age scan; its predicate (where it has one) is the
-- target's status list verbatim, so the planner can prove the job's WHERE
-- implies it.
--
-- 1. ai_agent_runs_finished_idx — finished runs by finished_at. The existing
--    ai_agent_runs_org_profile_finished_idx leads with org_id and cannot serve
--    a global range scan.
-- 2. patch_job_results_created_idx — every result by created_at. The existing
--    created_at indexes are partial on non-terminal or failed/queued statuses.
-- 3. automation_runs_terminal_completed_idx — terminal automation runs.
-- 4. report_runs_terminal_age_idx — finished report runs.
-- 5. user_notifications_read_at_idx — read notifications by read_at.
-- 6. remote_sessions_terminal_age_idx — ended remote sessions.
-- 7. sessions_created_at_idx — auth sessions by created_at.
--
-- Already served, no new index: security_posture_snapshots (device_id,
-- captured_at), cis_baseline_results (org_id, device_id, checked_at),
-- network_change_events (detected_at), patch_job_results (device_id,
-- patch_id, created_at), user_notifications (created_at). support_sessions is
-- small.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): several of these tables
-- are written on request and agent paths, and a plain CREATE INDEX takes a
-- SHARE lock that blocks every insert and update for the whole build.
-- CONCURRENTLY takes SHARE UPDATE EXCLUSIVE instead (writes continue), scans
-- the table twice, and waits for transactions already open on it. IF NOT
-- EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY build
-- leaves an INVALID index that IF NOT EXISTS would silently accept, so the DO
-- block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.<name>, then let autoMigrate re-run
-- this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_agent_runs_finished_idx
  ON public.ai_agent_runs (finished_at)
  WHERE finished_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS patch_job_results_created_idx
  ON public.patch_job_results (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS automation_runs_terminal_completed_idx
  ON public.automation_runs (completed_at)
  WHERE status IN ('completed', 'failed', 'partial', 'cancelled');

CREATE INDEX CONCURRENTLY IF NOT EXISTS report_runs_terminal_age_idx
  ON public.report_runs ((COALESCE(completed_at, created_at)))
  WHERE status IN ('completed', 'failed');

CREATE INDEX CONCURRENTLY IF NOT EXISTS user_notifications_read_at_idx
  ON public.user_notifications (read_at)
  WHERE read = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS remote_sessions_terminal_age_idx
  ON public.remote_sessions ((COALESCE(ended_at, created_at)))
  WHERE status IN ('disconnected', 'failed', 'denied');

CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_created_at_idx
  ON public.sessions (created_at);

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
       'ai_agent_runs_finished_idx',
       'patch_job_results_created_idx',
       'automation_runs_terminal_completed_idx',
       'report_runs_terminal_age_idx',
       'user_notifications_read_at_idx',
       'remote_sessions_terminal_age_idx',
       'sessions_created_at_idx'
     )
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'history retention index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
