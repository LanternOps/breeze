BEGIN;

-- ============================================================
-- RLS for incidents (has org_id)
-- ============================================================
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON incidents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON incidents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON incidents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON incidents;

CREATE POLICY breeze_org_isolation_select ON incidents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON incidents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON incidents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON incidents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for incident_evidence (has org_id)
-- ============================================================
ALTER TABLE incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON incident_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON incident_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_update ON incident_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON incident_evidence;

CREATE POLICY breeze_org_isolation_select ON incident_evidence
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON incident_evidence
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON incident_evidence
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON incident_evidence
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for incident_actions (has org_id)
-- ============================================================
ALTER TABLE incident_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON incident_actions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON incident_actions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON incident_actions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON incident_actions;

CREATE POLICY breeze_org_isolation_select ON incident_actions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON incident_actions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON incident_actions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON incident_actions
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
