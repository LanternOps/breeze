BEGIN;

-- ============================================================
-- RLS for device_event_logs (has org_id)
-- ============================================================
ALTER TABLE device_event_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_event_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_event_logs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_event_logs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_event_logs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_event_logs;

CREATE POLICY breeze_org_isolation_select ON device_event_logs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_event_logs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_event_logs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_event_logs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for log_search_queries (has org_id)
-- ============================================================
ALTER TABLE log_search_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_search_queries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON log_search_queries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON log_search_queries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON log_search_queries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON log_search_queries;

CREATE POLICY breeze_org_isolation_select ON log_search_queries
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON log_search_queries
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON log_search_queries
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON log_search_queries
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for log_correlation_rules (has org_id)
-- ============================================================
ALTER TABLE log_correlation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_correlation_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON log_correlation_rules;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON log_correlation_rules;
DROP POLICY IF EXISTS breeze_org_isolation_update ON log_correlation_rules;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON log_correlation_rules;

CREATE POLICY breeze_org_isolation_select ON log_correlation_rules
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON log_correlation_rules
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON log_correlation_rules
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON log_correlation_rules
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for log_correlations (has org_id)
-- ============================================================
ALTER TABLE log_correlations ENABLE ROW LEVEL SECURITY;
ALTER TABLE log_correlations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON log_correlations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON log_correlations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON log_correlations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON log_correlations;

CREATE POLICY breeze_org_isolation_select ON log_correlations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON log_correlations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON log_correlations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON log_correlations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
