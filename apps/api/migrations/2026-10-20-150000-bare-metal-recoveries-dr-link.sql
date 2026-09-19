-- Bare-metal recovery W05b (Task 6): link `bare_metal_recoveries` to the DR
-- execution and plan group that created it, and record the rebuild host that
-- executes an engine-driven (`bare_metal_rebuild`) recovery.
--
--   dr_execution_id     — the DR execution that dispatched this recovery
--                         (NULL for route- and Restore-as-VM-created rows).
--   dr_group_id         — the DR plan group the device belonged to.
--   executing_device_id — the Linux helper host running the rebuild engine
--                         (NULL for boot-media recoveries, where the target
--                         machine itself runs the restore).
--
-- All three are `ON DELETE SET NULL`: a recovery row is historical evidence
-- and must outlive the plan group / execution / host it referenced.
-- `executing_device_id` is a second device FK on the table;
-- CORE_DEVICE_CASCADE_DELETE_TABLES deletes by `device_id` only, so SET NULL
-- here is what covers deleting a rebuild host.
--
-- Export policy: all three classified `included` in CORE_TENANT_EXPORT_POLICY
-- (tenantExportPolicyRegistry.ts) in this same PR — plain tenant identifiers,
-- no SUSPICIOUS_NAME_PARTS hit, not jsonb/bytea.
--
-- RLS: bare_metal_recoveries is shape 1 (direct org_id); new columns do not
-- change the shape, so rls-coverage.integration.test.ts needs no change.
-- Cascade lists: the table is already registered in all four lists and sorts
-- before dr_executions / dr_plan_groups, so children-before-parents holds.
--
-- DDL ONLY: no row writes, so no `SELECT set_config('breeze.scope', ...)`
-- elevation is required. Idempotent via IF NOT EXISTS; no inner BEGIN/COMMIT.

ALTER TABLE bare_metal_recoveries
  ADD COLUMN IF NOT EXISTS dr_execution_id uuid NULL REFERENCES dr_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dr_group_id uuid NULL REFERENCES dr_plan_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS executing_device_id uuid NULL REFERENCES devices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bare_metal_recoveries_dr_execution_idx
  ON bare_metal_recoveries (dr_execution_id)
  WHERE dr_execution_id IS NOT NULL;
