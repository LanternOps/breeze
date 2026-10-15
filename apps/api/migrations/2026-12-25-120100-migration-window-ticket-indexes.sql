-- @no-transaction
-- Indexes for the ticket migration window columns added in
-- 2026-12-23-110000 (spec §3.2, §5). tickets and ticket_comments can be large,
-- so every index is built CONCURRENTLY and never write-locks them. IF NOT
-- EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY build
-- leaves an INVALID index that IF NOT EXISTS would silently accept, so the DO
-- block fails loudly in that state (same pattern as
-- 2026-12-13-120100-tickets-partner-feed-index.sql).
-- Recovery: DROP INDEX CONCURRENTLY the index it names, then let autoMigrate
-- re-run this file.

-- Imported tickets of one window (close-time counts, the "Imported" filter).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_migration_window
  ON public.tickets (migration_window_id) WHERE migration_window_id IS NOT NULL;

-- Imported comments of one window (close-time counts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_comments_migration_window
  ON public.ticket_comments (migration_window_id) WHERE migration_window_id IS NOT NULL;

-- Resume key: a rerun skips a comment its principal already imported.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ticket_comments_import_source_uq
  ON public.ticket_comments (origin_principal_id, import_source_id) WHERE import_source_id IS NOT NULL;

-- Exact, case-insensitive staff search by the source's ticket number.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_external_refs_org_external_number
  ON public.ticket_external_refs (org_id, lower(external_number)) WHERE external_number IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN (
           'idx_tickets_migration_window',
           'idx_ticket_comments_migration_window',
           'ticket_comments_import_source_uq',
           'idx_ticket_external_refs_org_external_number')
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration window index build left INVALID index(es): % — DROP INDEX CONCURRENTLY them and re-apply this migration', bad;
  END IF;
END $$;
