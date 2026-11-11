-- #4342 W2 (high-volume table retention): when script output was removed.
--
-- The script execution retention job (jobs/scriptExecutionRetention.ts)
-- scrubs stdout/stderr from finished runs older than
-- SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS and stamps this column, so the UI can
-- say "output removed after the retention window" instead of "no output", and
-- so the scrub never selects the same row twice. NULL = output never removed.
-- Report-only until SCRIPT_EXECUTION_RETENTION_ENFORCE=true: nothing writes
-- this column until an operator turns enforcement on.
--
-- Nullable, no default: a metadata-only ADD COLUMN, no table rewrite. No row
-- writes, so no system-scope election is needed. IF NOT EXISTS keeps
-- re-application a no-op.

ALTER TABLE public.script_executions
  ADD COLUMN IF NOT EXISTS output_purged_at timestamptz;

COMMENT ON COLUMN public.script_executions.output_purged_at IS
  'When the retention job removed stdout/stderr (#4342 W2). NULL = output never removed.';
