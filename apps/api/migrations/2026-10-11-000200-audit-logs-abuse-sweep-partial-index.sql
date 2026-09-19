-- @no-transaction
-- audit_logs: partial index for the abuse-signals sweep
-- (apps/api/src/services/abuseSignals/heuristics.ts, every 15 minutes).
--
-- The sweep counts, per partner, the last 24 h of `user.login.failed` and
-- denied `agent.enroll` rows. audit_logs has no index led by `action`, so each
-- of the three arms either walks every org's last-24-h slice through
-- audit_logs_org_timestamp_idx and filters `action` row by row (US prod
-- 2026-09-06: 106k buffers for 0 matching rows on one arm), or falls back to
-- a seq scan of the 2.4 GB heap when the org_id-IS-NULL arm cannot seek.
-- pg_stat_statements 08-30..09-06 on US: 152 calls, 151 s mean, 5.6 min max,
-- 85M shared buffer reads -- 680 GB for a job that wants ~1,800 rows.
--
-- Both actions are rare (US all-time: 596 login failures, 1,164 enrolls
-- against 5.6M rows), so a partial index over exactly those actions is a few
-- hundred kB and turns every arm into an index range scan. `action = 'x'` is
-- implied by the IN-list predicate (predtest expands the array), and texteq +
-- timestamp comparisons are leakproof, so the arms stay index conditions
-- under the RLS security qual as breeze_app.
--
-- CREATE INDEX CONCURRENTLY: every agent request inserts into audit_logs.
-- IF NOT EXISTS keeps re-application a no-op (prod may get it by hand first).
-- An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY audit_logs_abuse_sweep_idx, then let
-- autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_abuse_sweep_idx
  ON public.audit_logs (action, "timestamp" DESC)
  WHERE action IN ('user.login.failed', 'agent.enroll');

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.audit_logs'::regclass
     AND c.relname = 'audit_logs_abuse_sweep_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'audit_logs abuse-sweep index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
