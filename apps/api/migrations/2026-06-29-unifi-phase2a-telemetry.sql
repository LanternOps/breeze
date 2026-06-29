-- UniFi Phase 2a: agent-side deep telemetry (read-only). Three org-axis tables.

-- 1. unifi_collectors (per-console config; org-axis = collector agent's org) ----
CREATE TABLE IF NOT EXISTS unifi_collectors (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id          uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES organizations(id),
  site_id                 uuid NOT NULL REFERENCES sites(id),
  unifi_host_id           text NOT NULL,
  collector_device_id     uuid NOT NULL REFERENCES devices(id),
  controller_url          text NOT NULL,
  local_api_key_encrypted text NOT NULL,
  is_enabled              boolean NOT NULL DEFAULT true,
  poll_interval_seconds   integer NOT NULL DEFAULT 60,
  status                  varchar(20) NOT NULL DEFAULT 'pending',
  firmware_ok             boolean,
  last_poll_at            timestamptz,
  last_poll_status        varchar(16),
  last_poll_error         text,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_collectors_integration_host_idx
  ON unifi_collectors(integration_id, unifi_host_id);
CREATE INDEX IF NOT EXISTS unifi_collectors_device_idx
  ON unifi_collectors(collector_device_id) WHERE is_enabled;

ALTER TABLE unifi_collectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_collectors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_collectors;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_collectors;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_collectors;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_collectors;
CREATE POLICY breeze_org_isolation_select ON unifi_collectors
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_collectors
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_collectors
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_collectors
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 2. unifi_device_telemetry (latest per-device snapshot; org-axis) -------------
CREATE TABLE IF NOT EXISTS unifi_device_telemetry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id      uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id),
  site_id           uuid NOT NULL REFERENCES sites(id),
  unifi_device_id   text NOT NULL,
  mac               text,
  name              text,
  uptime_seconds    bigint,
  cpu_pct           real,
  mem_pct           real,
  tx_bytes          bigint,
  rx_bytes          bigint,
  num_clients       integer,
  poe_ports         jsonb,
  raw               jsonb NOT NULL,
  is_stale          boolean NOT NULL DEFAULT false,
  last_seen_at      timestamptz,
  first_synced_at   timestamptz NOT NULL DEFAULT now(),
  last_synced_at    timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_device_telemetry_collector_device_idx
  ON unifi_device_telemetry(collector_id, unifi_device_id);
CREATE INDEX IF NOT EXISTS unifi_device_telemetry_org_idx
  ON unifi_device_telemetry(org_id, site_id);

ALTER TABLE unifi_device_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_device_telemetry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_device_telemetry;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_device_telemetry;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_device_telemetry;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_device_telemetry;
CREATE POLICY breeze_org_isolation_select ON unifi_device_telemetry
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_device_telemetry
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_device_telemetry
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_device_telemetry
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 3. unifi_clients (current client associations; org-axis) ---------------------
CREATE TABLE IF NOT EXISTS unifi_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id        uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES organizations(id),
  site_id             uuid NOT NULL REFERENCES sites(id),
  mac                 text NOT NULL,
  hostname            text,
  ip_address          inet,
  connected_device_id text,
  uplink_port_idx     integer,
  is_wired            boolean,
  ssid                text,
  vlan                integer,
  signal_dbm          integer,
  tx_bytes            bigint,
  rx_bytes            bigint,
  uptime_seconds      bigint,
  discovered_asset_id uuid REFERENCES discovered_assets(id),
  raw                 jsonb NOT NULL,
  is_stale            boolean NOT NULL DEFAULT false,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_clients_collector_mac_idx
  ON unifi_clients(collector_id, mac);
CREATE INDEX IF NOT EXISTS unifi_clients_org_mac_idx
  ON unifi_clients(org_id, mac);

ALTER TABLE unifi_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_clients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_clients;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_clients;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_clients;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_clients;
CREATE POLICY breeze_org_isolation_select ON unifi_clients
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_clients
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_clients
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_clients
  FOR DELETE USING (public.breeze_has_org_access(org_id));
