-- @no-transaction
-- Tier-1 rows of the 2026-09-06 DB deep-dive (issue #5020) not covered by
-- 2026-10-11-000300-recurring-job-missing-indexes.sql (#5021): recurring-job
-- and hot-lookup predicates with no covering index. discovery_jobs and
-- organization_users had nothing beyond the primary key; automations had
-- partner_id / managed_by_agent_id / managed_by_monitor_id indexes but none
-- on org_id or enabled.
--
-- 1. discovery_jobs — grows one row per scan, forever.
--    a. (profile_id, status): discoveryWorker's per-profile in-flight check
--       (`profile_id = $1 AND status IN ('scheduled','running')`). The
--       schedule-due latest-run lookup (`profile_id = $1 ORDER BY
--       scheduled_at DESC NULLS LAST, created_at DESC LIMIT 1`) is narrowed
--       to one profile's rows by the leading column; the sort still runs.
--    b. (status, updated_at): discoveryWorker's 60 s stale-running and
--       stale-scheduled sweeps (`status = $1 AND updated_at < $2`, the latter
--       `ORDER BY updated_at LIMIT n`). Full, not partial: Drizzle binds the
--       status as a parameter.
--
-- 2. organization_users — membership lookups app-wide.
--    a. (org_id, user_id): org-scoped member reads; lets userRiskJobs'
--       `GROUP BY org_id` run as an ordered index-only scan; covers the
--       org_id FK for the app-level org cascade delete.
--    b. (user_id): a user's memberships (auth/login paths) and the user_id
--       FK for user deletes.
--    Not UNIQUE — uniqueness on existing data is a separate decision.
--
-- 3. automations (org_id) WHERE enabled — automationWorker's 60 s schedule
--    sweep (`enabled = $1`) and the org branch of the event path
--    (`(org_id = $1 OR (org_id IS NULL AND partner_id = $2)) AND enabled AND
--    retired_at IS NULL`); the partner branch stays on
--    automations_partner_id_idx. The planner proves the bound `enabled = $1` implies
--    the predicate on custom plans. Config-bounded today: while most rows are
--    enabled a seq scan stays the cheaper plan; this keeps the sweep off the
--    full table as disabled/retired automations accumulate.
--
-- CREATE INDEX CONCURRENTLY: all three tables take live writes. IF NOT EXISTS
-- keeps re-application a no-op. An interrupted CONCURRENTLY build leaves an
-- INVALID index that IF NOT EXISTS would silently accept, so the DO block
-- fails loudly. Recovery: DROP INDEX CONCURRENTLY <name>, then let
-- autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_jobs_profile_status_idx
  ON public.discovery_jobs (profile_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_jobs_status_updated_at_idx
  ON public.discovery_jobs (status, updated_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS organization_users_org_user_idx
  ON public.organization_users (org_id, user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS organization_users_user_id_idx
  ON public.organization_users (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS automations_enabled_org_idx
  ON public.automations (org_id) WHERE enabled;

DO $$
DECLARE
  bad text;
BEGIN
  -- Pair each index with its table so an unrelated same-named INVALID index
  -- elsewhere cannot abort this migration.
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.discovery_jobs'::regclass,     'discovery_jobs_profile_status_idx'),
      ('public.discovery_jobs'::regclass,     'discovery_jobs_status_updated_at_idx'),
      ('public.organization_users'::regclass, 'organization_users_org_user_idx'),
      ('public.organization_users'::regclass, 'organization_users_user_id_idx'),
      ('public.automations'::regclass,        'automations_enabled_org_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tier-1 sweep index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
