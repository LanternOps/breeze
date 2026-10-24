-- Ticket import attachments (#8313 W1; spec
-- docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
-- §4.2). An imported attachment is an ordinary ticket_attachments row; these
-- three columns say which import wrote it:
--   - migration_window_id: the window that wrote it. FK-less, a snapshot like
--     tickets.migration_window_id and ticket_comments.migration_window_id.
--   - origin_principal_id: the window's partner service principal. FK-less,
--     like ticket_comments.origin_principal_id.
--   - import_source_id: the source's attachment id, the resume key, unique per
--     principal (ticket_attachments_import_source_uq, built CONCURRENTLY in
--     2027-01-05-100100-ticket-import-attachment-indexes.sql).
--
-- The CHECK pins the import shape: the source id and the principal come
-- together, and an imported row has no uploader, has its window, and lives in
-- object storage (an import never writes bytes into `data`, §4.1). It is added
-- NOT VALID here and validated in the no-transaction file: inside this file's
-- transaction the ADD CONSTRAINT's ACCESS EXCLUSIVE lock would be held through
-- the validating scan. Every existing row has import_source_id NULL and
-- origin_principal_id NULL, so it passes.
--
-- No FK, so no cascade, merge or org-move change; the three columns are
-- `included` in the ticket_attachments export policy. No row is written, so no
-- system-scope elevation. Idempotent: ADD COLUMN IF NOT EXISTS, and the CHECK
-- is added only when absent (re-adding it would undo the VALIDATE).

ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS migration_window_id uuid;
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS origin_principal_id uuid;
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS import_source_id varchar(255);

DO $$ BEGIN
  ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_import_shape_chk CHECK (
    (import_source_id IS NULL) = (origin_principal_id IS NULL)
    AND (import_source_id IS NULL
         OR (uploaded_by_user_id IS NULL AND migration_window_id IS NOT NULL AND storage_backend = 's3'))
  ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
