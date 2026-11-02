-- @no-transaction
-- #10530: recover scheduled retries by due time without bloating the separate
-- created_at-ordered pending/retrying scan with retries lasting about 21 hours.
-- CREATE INDEX CONCURRENTLY avoids blocking live delivery writes. An interrupted
-- build leaves an INVALID index that IF NOT EXISTS would silently accept, so
-- the guard fails loudly. Drop that index concurrently before re-applying.
-- No row writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_scheduled_due_idx
  ON public.webhook_deliveries (next_retry_at)
  WHERE status = 'scheduled';

DO $$
DECLARE
  bad text;
BEGIN
  -- Match the table too so an unrelated same-named index cannot abort this migration.
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.webhook_deliveries'::regclass, 'webhook_deliveries_scheduled_due_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'webhook scheduled index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
