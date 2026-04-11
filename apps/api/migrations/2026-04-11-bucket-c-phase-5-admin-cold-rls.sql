-- 2026-04-11: Bucket C Phase 5 — admin/cold cluster RLS (JOIN policy shape).
--
-- These tables are written only from admin-initiated routes, webhooks,
-- or scheduled jobs — never from the agent hot path. Instead of
-- denormalizing `org_id` (the phases 1-4 pattern), use a join-through
-- subquery policy that reads `devices.org_id` at evaluation time. This
-- avoids schema churn and write-site updates at the cost of one subquery
-- per row evaluation. For cold tables the overhead is negligible.
--
-- Tables:
--   - automation_policy_compliance  (policy evaluation job writes)
--   - deployment_devices            (admin-initiated software deployments)
--   - deployment_results            (deployment outcome records)
--   - patch_job_results             (patch job executor writes)
--   - patch_rollbacks               (admin/AI-initiated rollbacks)
--   - file_transfers                (admin-initiated remote file transfers)
--
-- `mobile_devices` was initially in this phase but is actually user-
-- scoped (its `device_id` is a varchar platform identifier, not a FK
-- to `devices`). Moved to phase 6.
--
-- Policy shape:
--
--   USING (
--     EXISTS (
--       SELECT 1 FROM devices d
--        WHERE d.id = <table>.device_id
--          AND public.breeze_has_org_access(d.org_id)
--     )
--   )
--
-- NOTE: The subquery reads `devices`, which is itself under RLS keyed on
-- `org_id`. Under partner/org scope the caller sees devices for their
-- accessible orgs, so the EXISTS passes iff the target device's org is
-- in their accessible list. Under system scope breeze_has_org_access
-- short-circuits to TRUE so the policy passes unconditionally. Correct.
--
-- Fully idempotent.

BEGIN;

-- -------- Reusable inline policy template via DO block for each table --------
-- (Dynamic SQL would obscure intent; spelled out inline per table.)

-- -------- automation_policy_compliance --------
DROP POLICY IF EXISTS breeze_org_isolation_select ON automation_policy_compliance;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON automation_policy_compliance;
DROP POLICY IF EXISTS breeze_org_isolation_update ON automation_policy_compliance;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON automation_policy_compliance;
ALTER TABLE automation_policy_compliance ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_policy_compliance FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON automation_policy_compliance
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = automation_policy_compliance.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_insert ON automation_policy_compliance
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = automation_policy_compliance.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_update ON automation_policy_compliance
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = automation_policy_compliance.device_id
            AND public.breeze_has_org_access(d.org_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = automation_policy_compliance.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_delete ON automation_policy_compliance
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = automation_policy_compliance.device_id
            AND public.breeze_has_org_access(d.org_id))
  );

-- -------- deployment_devices --------
DROP POLICY IF EXISTS breeze_org_isolation_select ON deployment_devices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON deployment_devices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON deployment_devices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON deployment_devices;
ALTER TABLE deployment_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON deployment_devices
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_devices.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_insert ON deployment_devices
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_devices.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_update ON deployment_devices
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_devices.device_id
            AND public.breeze_has_org_access(d.org_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_devices.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_delete ON deployment_devices
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_devices.device_id
            AND public.breeze_has_org_access(d.org_id))
  );

-- -------- deployment_results --------
DROP POLICY IF EXISTS breeze_org_isolation_select ON deployment_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON deployment_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON deployment_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON deployment_results;
ALTER TABLE deployment_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_results FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON deployment_results
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_insert ON deployment_results
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_update ON deployment_results
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_delete ON deployment_results
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = deployment_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );

-- -------- patch_job_results --------
DROP POLICY IF EXISTS breeze_org_isolation_select ON patch_job_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON patch_job_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON patch_job_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON patch_job_results;
ALTER TABLE patch_job_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_job_results FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON patch_job_results
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_job_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_insert ON patch_job_results
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_job_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_update ON patch_job_results
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_job_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_job_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_delete ON patch_job_results
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_job_results.device_id
            AND public.breeze_has_org_access(d.org_id))
  );

-- -------- patch_rollbacks --------
DROP POLICY IF EXISTS breeze_org_isolation_select ON patch_rollbacks;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON patch_rollbacks;
DROP POLICY IF EXISTS breeze_org_isolation_update ON patch_rollbacks;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON patch_rollbacks;
ALTER TABLE patch_rollbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_rollbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON patch_rollbacks
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_rollbacks.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_insert ON patch_rollbacks
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_rollbacks.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_update ON patch_rollbacks
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_rollbacks.device_id
            AND public.breeze_has_org_access(d.org_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_rollbacks.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_delete ON patch_rollbacks
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_rollbacks.device_id
            AND public.breeze_has_org_access(d.org_id))
  );

-- -------- file_transfers --------
-- Has both device_id and user_id FKs. Use device_id since that path is
-- simpler (device.org_id) and matches the admin-initiated write flow.
DROP POLICY IF EXISTS breeze_org_isolation_select ON file_transfers;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON file_transfers;
DROP POLICY IF EXISTS breeze_org_isolation_update ON file_transfers;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON file_transfers;
ALTER TABLE file_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON file_transfers
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = file_transfers.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_insert ON file_transfers
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = file_transfers.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_update ON file_transfers
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = file_transfers.device_id
            AND public.breeze_has_org_access(d.org_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = file_transfers.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_delete ON file_transfers
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = file_transfers.device_id
            AND public.breeze_has_org_access(d.org_id))
  );

COMMIT;
