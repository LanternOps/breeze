-- M2 (#5998) Task 5: UniFi controller-site topology authority and coverage.
--
-- topology_generation (unifi_site_mappings, unifi_collectors): a server-owned
-- counter folded into the UniFi producer configuration generation. Revoking a
-- UniFi topology source (controller remap, collector change) advances it, so a
-- later re-authorization of the SAME mapping/collector (e.g. a remap back to the
-- original site) derives a NEW producer epoch — a source fenced under its
-- current epoch never re-baselines (collectionIngest admit()).
--
-- topology_coverage_reason/_at (unifi_controller_sites): one bounded, per
-- controller-site coverage note for resources that produced no topology
-- (e.g. `controller_site_unmapped`); NULL once the site is ingested again.
--
-- Additive, nullable-or-defaulted columns only; no rows are written.
ALTER TABLE unifi_site_mappings ADD COLUMN IF NOT EXISTS topology_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE unifi_collectors ADD COLUMN IF NOT EXISTS topology_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE unifi_controller_sites ADD COLUMN IF NOT EXISTS topology_coverage_reason varchar(64);
ALTER TABLE unifi_controller_sites ADD COLUMN IF NOT EXISTS topology_coverage_at timestamptz;

ALTER TABLE unifi_controller_sites DROP CONSTRAINT IF EXISTS unifi_controller_sites_topology_coverage_reason_chk;
ALTER TABLE unifi_controller_sites ADD CONSTRAINT unifi_controller_sites_topology_coverage_reason_chk
  CHECK (topology_coverage_reason IS NULL OR topology_coverage_reason ~ '^[a-z][a-z0-9_]{0,63}$');
