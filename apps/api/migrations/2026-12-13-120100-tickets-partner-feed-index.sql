-- @no-transaction
-- Keyset index for the partner tickets feed (see 2026-12-13-110000). Built
-- CONCURRENTLY so a busy tickets table is never write-locked during the
-- build. IF NOT EXISTS keeps re-application a no-op. An interrupted
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would
-- silently accept, so the DO block fails loudly in that state (same pattern
-- as 2026-10-30-130100-partner-api-alerts-feed-index.sql).
-- Recovery: DROP INDEX CONCURRENTLY public.idx_tickets_partner_feed_xid, then
-- let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_partner_feed_xid
  ON public.tickets (partner_feed_xid, id);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.tickets'::regclass
     AND c.relname = 'idx_tickets_partner_feed_xid'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tickets partner-feed index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
