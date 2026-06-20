CREATE TABLE IF NOT EXISTS onedrive_device_state (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  signed_in BOOLEAN NOT NULL DEFAULT false,
  onedrive_version VARCHAR(64),
  files_on_demand_on BOOLEAN NOT NULL DEFAULT false,
  kfm_folder_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  mounted_libraries JSONB NOT NULL DEFAULT '[]'::jsonb,
  entitled_libraries JSONB NOT NULL DEFAULT '[]'::jsonb,
  drift_entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_reported_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onedrive_device_state_org_idx
  ON onedrive_device_state (org_id);

ALTER TABLE onedrive_device_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE onedrive_device_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON onedrive_device_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON onedrive_device_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON onedrive_device_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON onedrive_device_state;

CREATE POLICY breeze_org_isolation_select ON onedrive_device_state
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON onedrive_device_state
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON onedrive_device_state
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON onedrive_device_state
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE onedrive_device_state TO breeze_app;
