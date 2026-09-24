-- @no-transaction
-- Keyset index for the partner alerts feed (see 2026-10-28-130000). Built
-- CONCURRENTLY so a large alerts table is not write-locked during the build.
-- If a previous CONCURRENTLY attempt failed it leaves an INVALID index that
-- IF NOT EXISTS would skip; drop it first so the build is retried.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_alerts_partner_feed_xid' AND NOT i.indisvalid
  ) THEN
    RAISE WARNING 'dropping invalid idx_alerts_partner_feed_xid from a failed concurrent build';
    EXECUTE 'DROP INDEX public.idx_alerts_partner_feed_xid';
  END IF;
END $$;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_partner_feed_xid
  ON public.alerts (partner_feed_xid, id);
