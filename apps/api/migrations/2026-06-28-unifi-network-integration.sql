-- UniFi Network Integration (Phase 1): cloud read-only inventory.
-- Partner-axis connection + sync ledger; org-axis site mappings + devices.

-- 1. unifi_integrations (partner-axis) -----------------------------------
CREATE TABLE IF NOT EXISTS unifi_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        uuid NOT NULL REFERENCES partners(id),
  base_url          text NOT NULL DEFAULT 'https://api.ui.com',
  api_key_encrypted text NOT NULL,
  account_label     text,
  is_active         boolean NOT NULL DEFAULT true,
  status            varchar(20) NOT NULL DEFAULT 'connected',
  last_sync_at      timestamptz,
  last_sync_status  varchar(20),
  last_sync_error   text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_integrations_partner_active_idx
  ON unifi_integrations(partner_id) WHERE is_active;

ALTER TABLE unifi_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON unifi_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON unifi_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON unifi_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON unifi_integrations;
CREATE POLICY breeze_partner_isolation_select ON unifi_integrations
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON unifi_integrations
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON unifi_integrations
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON unifi_integrations
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- 2. unifi_site_mappings (direct org_id) ---------------------------------
CREATE TABLE IF NOT EXISTS unifi_site_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id),
  site_id         uuid NOT NULL REFERENCES sites(id),
  unifi_host_id   text NOT NULL,
  unifi_site_id   text NOT NULL,
  unifi_host_name text,
  unifi_site_name text,
  wan_metrics     jsonb,
  wan_metrics_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_site_mappings_unique_site_idx
  ON unifi_site_mappings(integration_id, unifi_host_id, unifi_site_id);

ALTER TABLE unifi_site_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_site_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_site_mappings;
CREATE POLICY breeze_org_isolation_select ON unifi_site_mappings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_site_mappings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_site_mappings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_site_mappings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 3. unifi_devices (direct org_id) ---------------------------------------
CREATE TABLE IF NOT EXISTS unifi_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  site_id             uuid NOT NULL REFERENCES sites(id),
  integration_id      uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  mapping_id          uuid NOT NULL REFERENCES unifi_site_mappings(id) ON DELETE CASCADE,
  discovered_asset_id uuid REFERENCES discovered_assets(id),
  unifi_device_id     text NOT NULL,
  mac                 text,
  name                text,
  model               text,
  device_type         varchar(40),
  ip_address          inet,
  firmware_version    text,
  firmware_updatable  boolean,
  adoption_state      varchar(30),
  uptime_seconds      bigint,
  is_stale            boolean NOT NULL DEFAULT false,
  last_seen_at        timestamptz,
  raw                 jsonb NOT NULL,
  first_synced_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_devices_integration_device_idx
  ON unifi_devices(integration_id, unifi_device_id);
CREATE INDEX IF NOT EXISTS unifi_devices_org_mac_idx
  ON unifi_devices(org_id, mac);

ALTER TABLE unifi_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_devices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_devices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_devices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_devices;
CREATE POLICY breeze_org_isolation_select ON unifi_devices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_devices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_devices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_devices
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 4. unifi_sync_runs (partner-axis, partner_id denormalized) -------------
CREATE TABLE IF NOT EXISTS unifi_sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id    uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  partner_id        uuid NOT NULL REFERENCES partners(id),
  trigger           varchar(16) NOT NULL,
  status            varchar(16) NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  hosts_seen        integer NOT NULL DEFAULT 0,
  devices_created   integer NOT NULL DEFAULT 0,
  devices_updated   integer NOT NULL DEFAULT 0,
  devices_unchanged integer NOT NULL DEFAULT 0,
  devices_removed   integer NOT NULL DEFAULT 0,
  error             text
);
CREATE INDEX IF NOT EXISTS unifi_sync_runs_integration_started_idx
  ON unifi_sync_runs(integration_id, started_at DESC);

ALTER TABLE unifi_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_sync_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON unifi_sync_runs;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON unifi_sync_runs;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON unifi_sync_runs;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON unifi_sync_runs;
CREATE POLICY breeze_partner_isolation_select ON unifi_sync_runs
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON unifi_sync_runs
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON unifi_sync_runs
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON unifi_sync_runs
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
