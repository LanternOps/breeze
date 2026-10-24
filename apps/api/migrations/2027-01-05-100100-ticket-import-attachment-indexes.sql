-- @no-transaction
-- Ticket import attachments, part 2 (#8313 W1; spec
-- docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
-- §4.2), after 2027-01-05-100000-ticket-import-attachments.sql.
--
-- VALIDATE runs here, outside a transaction: on its own it takes only SHARE
-- UPDATE EXCLUSIVE, so reads and writes of ticket_attachments continue during
-- the scan. Validating a constraint that is already valid is a no-op.
--
-- Both indexes are built CONCURRENTLY and never write-lock the table. IF NOT
-- EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY build
-- leaves an INVALID index that IF NOT EXISTS would silently accept, so the DO
-- block fails loudly in that state (same pattern as
-- 2026-12-25-120100-migration-window-ticket-indexes.sql).
-- Recovery: DROP INDEX CONCURRENTLY the index it names, then let autoMigrate
-- re-run this file.

ALTER TABLE public.ticket_attachments VALIDATE CONSTRAINT ticket_attachments_import_shape_chk;

-- Resume key: a rerun reuses this principal's pending reservation of a source
-- file, and skips one already attached (spec §4.3).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ticket_attachments_import_source_uq
  ON public.ticket_attachments (origin_principal_id, import_source_id) WHERE import_source_id IS NOT NULL;

-- Imported attachments of one window (the close-time attachmentsImported count, §4.6).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_attachments_migration_window
  ON public.ticket_attachments (migration_window_id) WHERE migration_window_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN (
           'ticket_attachments_import_source_uq',
           'idx_ticket_attachments_migration_window')
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ticket import attachment index build left INVALID index(es): % — DROP INDEX CONCURRENTLY them and re-apply this migration', bad;
  END IF;
END $$;
