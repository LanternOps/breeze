-- #5396: `completed` means every file was read. A backup run that produced a
-- restorable snapshot but had one or more file read/upload failures below the
-- #3000 partial threshold is recorded as `completed_with_errors` instead.
--
-- Additive enum value only: no rows are rewritten (historic `completed` rows
-- that carried an error_count stay as recorded), no new column, so no RLS,
-- cascade or export-policy change. Idempotent via IF NOT EXISTS.
ALTER TYPE backup_status ADD VALUE IF NOT EXISTS 'completed_with_errors';
