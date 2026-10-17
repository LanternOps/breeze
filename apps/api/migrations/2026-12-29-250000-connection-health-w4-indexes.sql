-- @no-transaction
-- Connection health W4 (#8848, spec 2026-10-15 §1.3): partial indexes behind
-- the two new org-scoped health sources, so the reconciler's cost grows with
-- broken connections, not with orgs or deliveries.
--
-- 1. webhook_deliveries — append-only, no retention job, takes live writes.
--    a. (created_at) WHERE status = 'failed': the webhook source's broken
--       query, a range scan over the last hour of failed deliveries.
--    b. (webhook_id, created_at) WHERE status = 'failed': the latest terminal
--       failure of each tracked webhook (LATERAL … ORDER BY created_at DESC
--       LIMIT 1).
--    Both cover failed rows only, so they grow with failures, not traffic.
-- 2. google_workspace_connections (one row per org).
--    a. (id) WHERE last_probe_status = 'failed': the google_workspace source's
--       broken query.
--    b. (last_probe_at NULLS FIRST): the probe's due claim (never-probed
--       first, then oldest, LIMIT n).
-- Each predicate must stay implied by the matching source's broken query
-- (services/connectionHealth/sources/*), which writes the constants as
-- literals; connectionHealthSourceIndexes.integration.test.ts EXPLAINs them.
--
-- CREATE INDEX CONCURRENTLY: webhook_deliveries takes live writes and can be
-- large. IF NOT EXISTS keeps re-application a no-op. An interrupted
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would silently
-- accept, so the DO block fails loudly. Recovery: DROP INDEX CONCURRENTLY
-- <name>, then let autoMigrate re-run this file. No row writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_failed_recent_idx
  ON public.webhook_deliveries (created_at)
  WHERE status = 'failed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_failed_webhook_idx
  ON public.webhook_deliveries (webhook_id, created_at)
  WHERE status = 'failed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS google_workspace_connections_probe_failed_idx
  ON public.google_workspace_connections (id)
  WHERE last_probe_status = 'failed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS google_workspace_connections_probe_due_idx
  ON public.google_workspace_connections (last_probe_at NULLS FIRST);

DO $$
DECLARE
  bad text;
BEGIN
  -- Pair each index with its table so an unrelated same-named INVALID index
  -- elsewhere cannot abort this migration.
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.webhook_deliveries'::regclass,           'webhook_deliveries_failed_recent_idx'),
      ('public.webhook_deliveries'::regclass,           'webhook_deliveries_failed_webhook_idx'),
      ('public.google_workspace_connections'::regclass, 'google_workspace_connections_probe_failed_idx'),
      ('public.google_workspace_connections'::regclass, 'google_workspace_connections_probe_due_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'connection health W4 index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
