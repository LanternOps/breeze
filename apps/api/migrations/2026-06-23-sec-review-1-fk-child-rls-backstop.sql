-- Security review #1 (multi-tenant isolation): RLS backstop for five tenant
-- child tables that shipped with NO row-level security. Each reaches its tenant
-- only through a parent FK (no org_id column), so the org_id auto-discovery in
-- rls-coverage.integration.test.ts never surfaced them and they were never
-- backstopped. They are contained today by app-layer parent org-checks in every
-- request path, but CLAUDE.md mandates RLS as the source of truth ("no
-- app-layer-only fallback"): a future code path that reads/writes these by their
-- child id without re-checking the parent would silently cross tenants on the
-- bare breeze_app pool.
--
-- Shape follows the canonical FK-child pattern in 2026-05-30-fk-child-tables-rls.sql:
-- four per-command PERMISSIVE policies, each a single-table `FROM <parent>` EXISTS
-- (no JOIN — the contract test matches `FROM <parent>` literally). The
-- config_policy_* children reach their org through a 2–3 hop chain, expressed as
-- scalar subqueries so the EXISTS still has a single-table `FROM configuration_policies`.
-- The chain terminates at configuration_policies (org_id NOT NULL, no OR branch),
-- so it is #1016-safe under bound parameters.
--
-- Matching PARENT_FK_JOIN_POLICY_TABLES allowlist entries are added in the same PR.
-- Idempotent: ENABLE/FORCE are no-ops on re-apply; every policy is DROP IF EXISTS
-- then CREATE. No inner BEGIN/COMMIT (autoMigrate wraps each file in a txn).

-- ── config_policy_sensitive_data_settings ──────────────────────────────────
-- feature_link_id → config_policy_feature_links → configuration_policies.org_id
ALTER TABLE config_policy_sensitive_data_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_sensitive_data_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_sensitive_data_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_sensitive_data_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_sensitive_data_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_sensitive_data_settings;
CREATE POLICY breeze_org_isolation_select ON config_policy_sensitive_data_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_sensitive_data_settings FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_sensitive_data_settings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_sensitive_data_settings FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_sensitive_data_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);

-- ── config_policy_monitoring_settings ──────────────────────────────────────
-- feature_link_id → config_policy_feature_links → configuration_policies.org_id
ALTER TABLE config_policy_monitoring_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_monitoring_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_monitoring_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_monitoring_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_monitoring_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_monitoring_settings;
CREATE POLICY breeze_org_isolation_select ON config_policy_monitoring_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_monitoring_settings FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_monitoring_settings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_monitoring_settings FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_monitoring_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);

-- ── config_policy_monitoring_watches ───────────────────────────────────────
-- settings_id → config_policy_monitoring_settings → config_policy_feature_links
--   → configuration_policies.org_id
ALTER TABLE config_policy_monitoring_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_monitoring_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_monitoring_watches;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_monitoring_watches;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_monitoring_watches;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_monitoring_watches;
CREATE POLICY breeze_org_isolation_select ON config_policy_monitoring_watches FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_monitoring_watches FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_monitoring_watches FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND public.breeze_has_org_access(cp.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_monitoring_watches FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = (SELECT ms.feature_link_id FROM config_policy_monitoring_settings ms
                                  WHERE ms.id = config_policy_monitoring_watches.settings_id))
    AND public.breeze_has_org_access(cp.org_id))
);

-- ── dashboard_widgets ──────────────────────────────────────────────────────
-- dashboard_id → analytics_dashboards.org_id
ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dashboard_widgets;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dashboard_widgets;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dashboard_widgets;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dashboard_widgets;
CREATE POLICY breeze_org_isolation_select ON dashboard_widgets FOR SELECT USING (
  EXISTS (SELECT 1 FROM analytics_dashboards d WHERE d.id = dashboard_widgets.dashboard_id AND public.breeze_has_org_access(d.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON dashboard_widgets FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM analytics_dashboards d WHERE d.id = dashboard_widgets.dashboard_id AND public.breeze_has_org_access(d.org_id))
);
CREATE POLICY breeze_org_isolation_update ON dashboard_widgets FOR UPDATE USING (
  EXISTS (SELECT 1 FROM analytics_dashboards d WHERE d.id = dashboard_widgets.dashboard_id AND public.breeze_has_org_access(d.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM analytics_dashboards d WHERE d.id = dashboard_widgets.dashboard_id AND public.breeze_has_org_access(d.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON dashboard_widgets FOR DELETE USING (
  EXISTS (SELECT 1 FROM analytics_dashboards d WHERE d.id = dashboard_widgets.dashboard_id AND public.breeze_has_org_access(d.org_id))
);

-- ── backup_snapshot_files ──────────────────────────────────────────────────
-- snapshot_db_id → backup_snapshots.org_id
ALTER TABLE backup_snapshot_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshot_files;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshot_files;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshot_files;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshot_files;
CREATE POLICY breeze_org_isolation_select ON backup_snapshot_files FOR SELECT USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_files.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON backup_snapshot_files FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_files.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_update ON backup_snapshot_files FOR UPDATE USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_files.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_files.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON backup_snapshot_files FOR DELETE USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_files.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
