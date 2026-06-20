CREATE TABLE IF NOT EXISTS config_policy_onedrive_libraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id UUID NOT NULL REFERENCES config_policy_onedrive_settings(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  library_id VARCHAR(1024) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  site_url VARCHAR(1024),
  site_id VARCHAR(512),
  web_id VARCHAR(128),
  list_id VARCHAR(128),
  targeting_mode VARCHAR(20) NOT NULL DEFAULT 'everyone',
  group_id VARCHAR(128),
  group_name VARCHAR(255),
  hive_scope VARCHAR(8) NOT NULL DEFAULT 'hkcu',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT onedrive_libraries_targeting_mode_check CHECK (
    targeting_mode IN ('everyone', 'graph_group', 'local_ad_group')
  ),
  CONSTRAINT onedrive_libraries_hive_scope_check CHECK (hive_scope IN ('hkcu', 'hklm')),
  CONSTRAINT onedrive_libraries_group_required_check CHECK (
    targeting_mode = 'everyone' OR group_id IS NOT NULL OR group_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS onedrive_libraries_settings_idx
  ON config_policy_onedrive_libraries (settings_id);
CREATE INDEX IF NOT EXISTS onedrive_libraries_org_idx
  ON config_policy_onedrive_libraries (org_id);

ALTER TABLE config_policy_onedrive_libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_onedrive_libraries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_onedrive_libraries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_onedrive_libraries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_onedrive_libraries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_onedrive_libraries;

CREATE POLICY breeze_org_isolation_select ON config_policy_onedrive_libraries
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON config_policy_onedrive_libraries
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON config_policy_onedrive_libraries
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON config_policy_onedrive_libraries
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE config_policy_onedrive_libraries TO breeze_app;
