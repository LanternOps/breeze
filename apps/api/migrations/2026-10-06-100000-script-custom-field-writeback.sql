-- Script custom-field write-back (#2698).
--
-- 1. custom_field_definitions.script_write — per-field opt-in gate. A script
--    result may only write a field whose definition sets this. DEFAULT false
--    means no existing field becomes script-writable on deploy; an admin turns
--    it on deliberately, per field, in Settings -> Custom Fields.
-- 2. script_executions.custom_field_result — per-run summary of what the
--    write-back applied and rejected, so a rejected write is visible to the
--    operator instead of vanishing. NULL for every run that wrote nothing,
--    which is the overwhelming majority.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). No inner BEGIN/COMMIT — autoMigrate
-- wraps each file in a transaction. No RLS change: custom_field_definitions is
-- already dual-axis (2026-06-11-i-custom-fields-dual-axis-rls.sql) and
-- script_executions is already org-scoped shape 1; a new column inherits both.
-- No data is read or rewritten, so there is no row count to report.

ALTER TABLE public.custom_field_definitions
  ADD COLUMN IF NOT EXISTS script_write boolean NOT NULL DEFAULT false;

ALTER TABLE public.script_executions
  ADD COLUMN IF NOT EXISTS custom_field_result jsonb;

COMMENT ON COLUMN public.custom_field_definitions.script_write IS
  'When true, a script running on a device may write this field via the ::breeze:custom-fields:: marker (#2698).';
COMMENT ON COLUMN public.script_executions.custom_field_result IS
  'Summary of custom-field writes applied/rejected for this run: {"applied":[...],"rejected":[{"key","reason"}]} (#2698).';
