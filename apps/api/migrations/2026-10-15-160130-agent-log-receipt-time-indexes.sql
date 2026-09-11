-- @no-transaction
-- Receipt time is the authoritative retention/default-recency clock for agent
-- diagnostic logs. Keep the existing event-time indexes: explicit event-time
-- investigations and incident RCA still use agent_logs.timestamp.
--
-- agent_logs is a hot agent-write table, so build these online. Each statement
-- is independently idempotent for autoMigrate's no-transaction retry lane. An
-- interrupted concurrent build can leave an INVALID index that IF NOT EXISTS
-- would otherwise silently retain, so the final block fails loudly. Recovery:
-- DROP INDEX CONCURRENTLY <invalid name>, then re-apply this migration.
--
-- OPERATOR NOTE -- BUILD THESE BY HAND BEFORE THE RELEASE ROLLS ON EU/US.
-- CONCURRENTLY does not block agent writes (ShareUpdateExclusiveLock), but it
-- IS a two-pass scan that waits on older transactions, and autoMigrate runs
-- inside initializeDatabaseForStartup, which index.ts awaits BEFORE serve().
-- So on a multi-million-row agent_logs the API does not accept traffic until
-- all three builds finish, and a boot killed mid-build leaves an INVALID index
-- that makes the DO block below abort every subsequent boot -- a crash loop
-- until an operator runs DROP INDEX CONCURRENTLY. Run these three statements
-- against the live database first (psql, any time, no downtime); IF NOT EXISTS
-- then makes this migration instant when the release deploys:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_logs_created_at_idx
--     ON agent_logs (created_at);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_logs_device_created_at_idx
--     ON agent_logs (device_id, created_at DESC, id DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_logs_org_created_at_idx
--     ON agent_logs (org_id, created_at DESC, id DESC);
--
-- Then confirm all three report indisvalid = true before deploying.

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_logs_created_at_idx
  ON agent_logs (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_logs_device_created_at_idx
  ON agent_logs (device_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_logs_org_created_at_idx
  ON agent_logs (org_id, created_at DESC, id DESC);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.agent_logs'::regclass, 'agent_logs_created_at_idx'),
      ('public.agent_logs'::regclass, 'agent_logs_device_created_at_idx'),
      ('public.agent_logs'::regclass, 'agent_logs_org_created_at_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c
      ON c.relname = expected.idx
     AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i
      ON i.indexrelid = c.oid
     AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'agent-log receipt-time index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
