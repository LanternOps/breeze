-- #3162: correlate a script_executions row back to the automation run that
-- queued it, so the automation run-history panel can show the script's real
-- stdout per device instead of only the automation's own log lines.
--
-- No FK constraint on purpose: `automation_runs` is defined in
-- apps/api/src/db/schema/automations.ts, which already imports
-- apps/api/src/db/schema/scripts.ts. Declaring a Drizzle `.references()` the
-- other way would close an import cycle between the two schema modules.
-- Consistent with the existing bare-uuid `automation_runs.config_policy_id`.
-- Readers filter on equality (`WHERE automation_run_id = $run`), so a stale id
-- left behind by a purged run simply matches nothing.
ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS automation_run_id uuid;

CREATE INDEX IF NOT EXISTS script_executions_automation_run_id_idx
  ON script_executions (automation_run_id)
  WHERE automation_run_id IS NOT NULL;
