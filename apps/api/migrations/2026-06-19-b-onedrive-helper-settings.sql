-- Base OneDrive provisioning settings (one row per onedrive_helper feature link).
-- Direct org_id RLS shape 1. Idempotent throughout.
-- autoMigrate wraps this file in a transaction.

CREATE TABLE IF NOT EXISTS config_policy_onedrive_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  silent_account_config BOOLEAN NOT NULL DEFAULT true,
  files_on_demand BOOLEAN NOT NULL DEFAULT true,
  kfm_silent_opt_in BOOLEAN NOT NULL DEFAULT false,
  kfm_folders JSONB NOT NULL DEFAULT '["Desktop","Documents","Pictures"]'::jsonb,
  kfm_block_opt_out BOOLEAN NOT NULL DEFAULT false,
  tenant_association_id VARCHAR(64),
  restart_on_change BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT onedrive_settings_kfm_folders_array_check CHECK (jsonb_typeof(kfm_folders) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS onedrive_settings_feature_link_uniq
  ON config_policy_onedrive_settings (feature_link_id);
CREATE INDEX IF NOT EXISTS onedrive_settings_org_idx
  ON config_policy_onedrive_settings (org_id);

ALTER TABLE config_policy_onedrive_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_onedrive_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_onedrive_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_onedrive_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_onedrive_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_onedrive_settings;

CREATE POLICY breeze_org_isolation_select ON config_policy_onedrive_settings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON config_policy_onedrive_settings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON config_policy_onedrive_settings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON config_policy_onedrive_settings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE config_policy_onedrive_settings TO breeze_app;
