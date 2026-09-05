-- Let a fleet remediation run carry an operator-chosen run context (#4888).
--
-- The Fix flow's picker has always RENDERED a System / logged-in-user select
-- and then discarded the answer (FixPickerModal.tsx handed it to a `_runAs`
-- parameter), because the dispatcher read `runAs` straight off the stored
-- script row (services/fleetFindings/dispatch.ts). A control that silently
-- does nothing is worse than no control; this column is what lets the
-- dispatcher honour it.
--
-- NULLABLE with no default, and NULL means "use the script's saved default" —
-- the exact behaviour every existing run had, so nothing changes for rows
-- written before this column existed.
ALTER TABLE fleet_remediation_runs
  ADD COLUMN IF NOT EXISTS run_as script_run_as;

COMMENT ON COLUMN fleet_remediation_runs.run_as IS
  'Operator-chosen run context for this remediation run; NULL = the script''s saved default.';
