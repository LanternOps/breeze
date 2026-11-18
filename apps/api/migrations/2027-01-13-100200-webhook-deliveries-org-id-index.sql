-- @no-transaction
-- #10531: erasure/export lookup by event org without blocking delivery writes.
-- An interrupted concurrent build can leave an INVALID index; fail loudly
-- rather than accepting it on re-application. No row writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_org_idx
  ON public.webhook_deliveries (org_id);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.webhook_deliveries'::regclass, 'webhook_deliveries_org_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'webhook org index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
