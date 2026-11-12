-- @no-transaction
-- #11772: indexes behind the connection-health `backup_destination` source
-- (services/connectionHealth/sources/backupDestination.ts). backup_jobs had
-- only single-column indexes and completed_at was unindexed, so both of the
-- source's reads would otherwise scan job history that grows with every run.
--
-- 1. backup_jobs_unsuccessful_completed_at_idx (completed_at, config_id)
--    WHERE status IN ('failed', 'partial', 'completed_with_errors'):
--    the broken query, a range scan over the last 72 h of unsuccessful jobs
--    (it reads each row's status and error_log from the heap to classify it).
--    Covers unsuccessful rows only, so it grows with failures, not traffic.
-- 2. backup_jobs_config_completed_at_idx (config_id, completed_at):
--    the evidence read, every terminal outcome (successes included, since
--    recovery is affirmative) of the candidate and tracked configs inside the
--    lookback. Without it the read walks a config's whole job history through
--    backup_jobs_config_id_idx and filters by time.
-- The broken query writes its status list as a literal so the planner can
-- match the partial predicate; connectionHealthSourceIndexes.integration.test.ts
-- EXPLAINs both reads.
--
-- CREATE INDEX CONCURRENTLY: backup_jobs takes live writes from every backup
-- run and can be large. IF NOT EXISTS keeps re-application a no-op. An
-- interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly. Recovery:
-- DROP INDEX CONCURRENTLY <name>, then let autoMigrate re-run this file.
-- No row writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS backup_jobs_unsuccessful_completed_at_idx
  ON public.backup_jobs (completed_at, config_id)
  WHERE status IN ('failed', 'partial', 'completed_with_errors');

CREATE INDEX CONCURRENTLY IF NOT EXISTS backup_jobs_config_completed_at_idx
  ON public.backup_jobs (config_id, completed_at);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.backup_jobs'::regclass
     AND c.relname IN ('backup_jobs_unsuccessful_completed_at_idx', 'backup_jobs_config_completed_at_idx')
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'backup_jobs destination-health index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
