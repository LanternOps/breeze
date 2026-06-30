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
