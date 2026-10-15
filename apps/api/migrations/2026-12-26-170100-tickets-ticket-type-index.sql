-- @no-transaction
-- #7900 (feature #8592 W01): org ticket queues filtered by type (the Service
-- Desk per-type views): `org_id = $1 AND ticket_type IN (...) AND status ...
-- AND deleted_at IS NULL`. Partial on live tickets, matching the staff list
-- route's default soft-delete predicate.
--
-- CREATE INDEX CONCURRENTLY: tickets takes live writes, and the runner wraps a
-- transactional migration in one transaction, so building this inside the
-- column migration would hold its ACCESS EXCLUSIVE lock for the whole scan.
-- IF NOT EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY
-- build leaves an INVALID index that IF NOT EXISTS would silently accept, so
-- the DO block fails loudly. Recovery: DROP INDEX CONCURRENTLY
-- tickets_org_type_status_idx, then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_org_type_status_idx
  ON public.tickets (org_id, ticket_type, status) WHERE deleted_at IS NULL;

DO $$
DECLARE
  bad text;
BEGIN
  -- Pair the index with its table so an unrelated same-named INVALID index
  -- elsewhere cannot abort this migration.
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.tickets'::regclass, 'tickets_org_type_status_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ticket_type index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
