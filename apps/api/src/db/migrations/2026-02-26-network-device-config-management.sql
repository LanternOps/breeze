BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'network_config_type') THEN
    CREATE TYPE network_config_type AS ENUM ('running', 'startup');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'network_config_risk_level') THEN
    CREATE TYPE network_config_risk_level AS ENUM ('low', 'medium', 'high', 'critical');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS network_device_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  asset_id uuid NOT NULL REFERENCES discovered_assets(id) ON DELETE CASCADE,
  config_type network_config_type NOT NULL,
  config_encrypted text NOT NULL,
  hash varchar(128) NOT NULL,
  changed_from_previous boolean NOT NULL DEFAULT false,
  captured_at timestamp NOT NULL,
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS net_cfg_org_asset_captured_idx
  ON network_device_configs (org_id, asset_id, captured_at);

CREATE INDEX IF NOT EXISTS net_cfg_org_asset_type_captured_idx
  ON network_device_configs (org_id, asset_id, config_type, captured_at);

CREATE TABLE IF NOT EXISTS network_device_firmware (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  asset_id uuid NOT NULL REFERENCES discovered_assets(id) ON DELETE CASCADE,
  current_version varchar(80),
  latest_version varchar(80),
  eol_date timestamp,
  cve_count integer NOT NULL DEFAULT 0,
  last_checked_at timestamp,
  metadata jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS net_fw_org_asset_idx
  ON network_device_firmware (org_id, asset_id);

CREATE INDEX IF NOT EXISTS net_fw_org_last_checked_idx
  ON network_device_firmware (org_id, last_checked_at);

CREATE TABLE IF NOT EXISTS network_config_diffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  asset_id uuid NOT NULL REFERENCES discovered_assets(id) ON DELETE CASCADE,
  previous_config_id uuid NOT NULL REFERENCES network_device_configs(id) ON DELETE CASCADE,
  current_config_id uuid NOT NULL REFERENCES network_device_configs(id) ON DELETE CASCADE,
  summary text,
  diff text NOT NULL,
  risk_level network_config_risk_level NOT NULL DEFAULT 'low',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS net_cfg_diff_org_asset_created_idx
  ON network_config_diffs (org_id, asset_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS net_cfg_diff_current_cfg_idx
  ON network_config_diffs (current_config_id);

ALTER TABLE network_device_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_device_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON network_device_configs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON network_device_configs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON network_device_configs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON network_device_configs;

CREATE POLICY breeze_org_isolation_select ON network_device_configs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON network_device_configs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON network_device_configs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON network_device_configs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE network_device_firmware ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_device_firmware FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON network_device_firmware;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON network_device_firmware;
DROP POLICY IF EXISTS breeze_org_isolation_update ON network_device_firmware;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON network_device_firmware;

CREATE POLICY breeze_org_isolation_select ON network_device_firmware
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON network_device_firmware
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON network_device_firmware
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON network_device_firmware
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE network_config_diffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_config_diffs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON network_config_diffs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON network_config_diffs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON network_config_diffs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON network_config_diffs;

CREATE POLICY breeze_org_isolation_select ON network_config_diffs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON network_config_diffs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON network_config_diffs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON network_config_diffs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
