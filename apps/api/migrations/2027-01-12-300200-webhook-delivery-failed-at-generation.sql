-- @no-transaction
-- failed_at records terminal failure time: retry schedules outlive the health window.
-- webhook_generation preserves the approved configuration across durable re-drives.
-- No backfill: legacy failed rows keep NULL failed_at. Tracked health and retention
-- reads fall back to created_at; NULL failed_at rows do not open new incidents.
-- NULL webhook_generation falls back to the webhook's current generation.
-- Concurrent index builds avoid blocking live writes; the guard rejects INVALID builds.
-- No row writes.

ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS failed_at timestamp NULL;
ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS webhook_generation integer NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_failed_at_recent_idx
  ON public.webhook_deliveries (failed_at)
  WHERE status = 'failed';

DROP INDEX CONCURRENTLY IF EXISTS public.webhook_deliveries_failed_recent_idx;

DO $$
DECLARE
  bad text;
BEGIN
  -- Match the table too so an unrelated same-named index cannot abort this migration.
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.webhook_deliveries'::regclass, 'webhook_deliveries_failed_at_recent_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'webhook failure-time index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
