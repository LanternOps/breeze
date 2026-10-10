-- #3834 W01: inline `workload_inventory` configuration feature.
-- Settings child reaches its org/partner through feature_link ->
-- configuration_policies (parent-chain RLS, same shape as
-- config_policy_time_sync_settings) plus the additive SELECT-only partner-wide
-- branch (a partner-wide policy must reach org-scoped agent/heartbeat reads).
-- No row writes in this file.
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'workload_inventory';

CREATE TABLE IF NOT EXISTS config_policy_workload_inventory_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  docker_enabled boolean NOT NULL DEFAULT true,
  podman_enabled boolean NOT NULL DEFAULT true,
  hyperv_enabled boolean NOT NULL DEFAULT true,
  proxmox_enabled boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 60,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT config_policy_workload_inventory_interval_chk CHECK (interval_minutes BETWEEN 15 AND 1440)
);
ALTER TABLE config_policy_workload_inventory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_workload_inventory_settings FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t text := 'config_policy_workload_inventory_settings';
  predicate text;
BEGIN
  predicate := format('EXISTS (SELECT 1 FROM configuration_policies policy WHERE policy.id = (SELECT link.config_policy_id FROM config_policy_feature_links link WHERE link.id = %I.feature_link_id) AND (breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)))', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_select ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_insert ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_update ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_delete ON %I', t);
  EXECUTE format('CREATE POLICY breeze_parent_select ON %I FOR SELECT USING (%s)', t, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_insert ON %I FOR INSERT WITH CHECK (%s)', t, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t, predicate, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_delete ON %I FOR DELETE USING (%s)', t, predicate);
END $$;
DROP POLICY IF EXISTS config_policy_workload_inventory_settings_partner_wide_select ON config_policy_workload_inventory_settings;
CREATE POLICY config_policy_workload_inventory_settings_partner_wide_select
ON config_policy_workload_inventory_settings FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (
      SELECT fl.config_policy_id FROM config_policy_feature_links fl
      WHERE fl.id = config_policy_workload_inventory_settings.feature_link_id
    )
    AND cp.org_id IS NULL
    AND cp.partner_id = public.breeze_current_partner_id()
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON config_policy_workload_inventory_settings TO breeze_app;
