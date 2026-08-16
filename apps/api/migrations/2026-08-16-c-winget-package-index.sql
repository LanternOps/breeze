-- Searchable mirror of the microsoft/winget-pkgs manifest tree (spec:
-- docs/superpowers/specs/vuln-patch/2026-08-15-package-manager-software-library-design.md).
--
-- One row per winget package ID (`Vendor.Product`), derived from repo PATHS
-- only — no manifest contents are parsed here. Refreshed once per 24h by the
-- `winget-index-sync` BullMQ worker; per-package detail is fetched lazily at
-- import time.
--
-- Tenancy: platform-global, NO tenant axis at all — the winget catalog is
-- public data identical for every partner. Mirrors third_party_package_catalog
-- (2026-05-13-b), which is likewise a system-wide curated catalog, except that
-- this table additionally carries forced RLS so that only the system DB
-- context (the sync worker) may write. Reads are open to every DB context via
-- a permissive `USING (true)` SELECT policy because the rows contain no tenant
-- data. Registered in INTENTIONAL_UNSCOPED in
-- rls-coverage.integration.test.ts. No org_id/device_id column, so no cascade,
-- device-cascade or export-policy registration applies.
--
-- Idempotent: IF NOT EXISTS + DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS winget_package_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id varchar(256) NOT NULL,
  vendor_segment varchar(200) NOT NULL,
  name_segment varchar(200) NOT NULL,
  latest_version varchar(128),
  -- Generation marker: the commit SHA of the sync run that last wrote this
  -- row. Rows still carrying an older SHA after a fully-successful run are
  -- stale and get deleted (generation semantics without a second table).
  synced_commit_sha varchar(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS winget_package_index_package_id_uq
  ON winget_package_index (package_id);
CREATE INDEX IF NOT EXISTS winget_package_index_name_segment_idx
  ON winget_package_index (name_segment);
CREATE INDEX IF NOT EXISTS winget_package_index_synced_commit_sha_idx
  ON winget_package_index (synced_commit_sha);

ALTER TABLE winget_package_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE winget_package_index FORCE ROW LEVEL SECURITY;

-- Public read: no tenant data, and the /software/package-search route reads it
-- from an ordinary org-scoped request context.
DROP POLICY IF EXISTS winget_package_index_read ON winget_package_index;
CREATE POLICY winget_package_index_read ON winget_package_index
  FOR SELECT USING (true);

-- Writes are system-context only (the sync worker). Same shape as
-- os_vulnerabilities_system_only in 2026-06-23-vuln-os-facts.sql.
DROP POLICY IF EXISTS winget_package_index_system_write ON winget_package_index;
CREATE POLICY winget_package_index_system_write ON winget_package_index
  FOR ALL
  USING (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
