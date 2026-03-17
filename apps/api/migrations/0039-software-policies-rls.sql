BEGIN;

-- ============================================================
-- RLS for software_policies (has org_id)
-- ============================================================
ALTER TABLE software_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_policies;

CREATE POLICY breeze_org_isolation_select ON software_policies
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON software_policies
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON software_policies
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON software_policies
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for software_policy_audit (has org_id)
-- ============================================================
ALTER TABLE software_policy_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_policy_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_policy_audit;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_policy_audit;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_policy_audit;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_policy_audit;

CREATE POLICY breeze_org_isolation_select ON software_policy_audit
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON software_policy_audit
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON software_policy_audit
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON software_policy_audit
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for software_compliance_status (no org_id — join through devices)
-- ============================================================
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

COMMIT;
