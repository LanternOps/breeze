-- #6958 PR E: (1) RLS fix-forward on software_compliance_status (shape 5,
-- device-join); (2) the service names the compliance worker asks the agent to
-- watch. DDL only; writes no rows.
--
-- (1) WHY A FIX-FORWARD WHEN 0039 ALREADY HAS THESE POLICIES
-- 0039-software-policies-rls.sql created exactly the four policies below. But
-- a FRESH database never runs 0039: autoMigrate applies 0001-baseline.sql and
-- only MARKS 0002-0065 (LEGACY_CUTOFF) applied, and the baseline carries no
-- RLS for this table. So:
--   * a database created from the baseline (every install since the
--     consolidation, CI, the test stack) has had this table with RLS
--     DISABLED and no policies — measured on a fresh stack before this file:
--     relrowsecurity = f, relforcerowsecurity = f, 0 rows in pg_policies;
--   * a database that predates the consolidation ran 0039 for real and has
--     the policies; for it the block below is an idempotent re-assert.
-- rls-coverage carried the table as UNREVIEWED_RLS_CLASSIFICATION_DEBT ("no
-- RLS"), which was accurate for fresh databases. PR E adds an agent-read
-- surface (derived service watches, read in the agent's own context), which
-- must not rest on an unprotected table, so the table moves to
-- DEVICE_ID_JOIN_POLICY_TABLES in the same PR.
--
-- Every caller already runs in a context that admits the device's org (the
-- compliance and remediation workers in system scope; request paths under the
-- caller's withDbAccessContext; the agent command-result path in the agent's
-- org-scoped context), so enabling RLS here narrows nothing those callers
-- legitimately read.
--
-- (2) service_watches jsonb: [{ "name": "<service>" }], NULL when the policy
-- derives no names for the device. Restart authority is NOT stored; the
-- heartbeat re-derives it from the live software_policies row on every read.
-- No export/cascade/merge registration is needed: the table has no org_id and
-- no tenantExportPolicyRegistry / orgMergeRegistry / org-cascade entry (it is
-- removed with its device or policy by ON DELETE CASCADE).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; DROP POLICY IF EXISTS then CREATE.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).
-- Policy shape copied from 2026-04-11-bucket-c-phase-5-admin-cold-rls.sql
-- (automation_policy_compliance, a DEVICE_ID_JOIN_POLICY_TABLES member).

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE software_compliance_status ADD COLUMN IF NOT EXISTS service_watches jsonb;

ALTER TABLE software_compliance_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_compliance_status FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_compliance_status;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_compliance_status;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_compliance_status;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_compliance_status;

CREATE POLICY breeze_org_isolation_select ON software_compliance_status
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = software_compliance_status.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_insert ON software_compliance_status
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = software_compliance_status.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_update ON software_compliance_status
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = software_compliance_status.device_id
            AND public.breeze_has_org_access(d.org_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = software_compliance_status.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
CREATE POLICY breeze_org_isolation_delete ON software_compliance_status
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM devices d WHERE d.id = software_compliance_status.device_id
            AND public.breeze_has_org_access(d.org_id))
  );
