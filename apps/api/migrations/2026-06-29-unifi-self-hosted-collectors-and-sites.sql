-- UniFi self-hosted controllers: one collector row per controller (no cloud
-- host id), plus the agent-reported controller-site discovery table.

-- 1. Collector host id becomes nullable; a self-hosted controller has no cloud host.
ALTER TABLE unifi_collectors ALTER COLUMN unifi_host_id DROP NOT NULL;

-- Replace the unconditional unique (integration, host) with a partial that only
-- governs cloud collectors (host id present). Self-hosted rows (null host id) are
-- governed by a separate (integration, controller_url) unique index below.
DROP INDEX IF EXISTS unifi_collectors_integration_host_idx;
CREATE UNIQUE INDEX IF NOT EXISTS unifi_collectors_integration_host_idx
  ON unifi_collectors(integration_id, unifi_host_id)
  WHERE unifi_host_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unifi_collectors_integration_url_idx
  ON unifi_collectors(integration_id, controller_url)
  WHERE unifi_host_id IS NULL;

-- 2. unifi_controller_sites: the local sites the agent discovered on a self-hosted
-- controller, so the mapping UI can list them. org-axis = collector agent's org.
CREATE TABLE IF NOT EXISTS unifi_controller_sites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id  uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  local_site_id text NOT NULL,
  name          text,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_controller_sites_collector_site_idx
  ON unifi_controller_sites(collector_id, local_site_id);

ALTER TABLE unifi_controller_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_controller_sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_controller_sites;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_controller_sites;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_controller_sites;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_controller_sites;
CREATE POLICY breeze_org_isolation_select ON unifi_controller_sites
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_controller_sites
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_controller_sites
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_controller_sites
  FOR DELETE USING (public.breeze_has_org_access(org_id));
