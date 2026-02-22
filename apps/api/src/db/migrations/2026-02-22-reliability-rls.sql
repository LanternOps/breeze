BEGIN;

-- ============================================================
-- RLS for device_reliability (has org_id)
-- ============================================================
ALTER TABLE device_reliability ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_reliability FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_reliability;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_reliability;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_reliability;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_reliability;

CREATE POLICY breeze_org_isolation_select ON device_reliability
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_reliability
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_reliability
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_reliability
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for device_reliability_history (has org_id)
-- ============================================================
ALTER TABLE device_reliability_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_reliability_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_reliability_history;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_reliability_history;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_reliability_history;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_reliability_history;

CREATE POLICY breeze_org_isolation_select ON device_reliability_history
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_reliability_history
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_reliability_history
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_reliability_history
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
