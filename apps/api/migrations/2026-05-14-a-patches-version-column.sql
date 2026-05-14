-- Add `version` column to `patches` so CVE enrichment can query OSV with the
-- agent-reported available version (previously stored only on `device_patches`
-- as `installed_version`, or in `metadata->>'version'` ad hoc).
ALTER TABLE patches
  ADD COLUMN IF NOT EXISTS version varchar(64);

-- Composite lookup index used by the enrichment worker join +
-- agent patch upsert paths (source, package_id, version).
CREATE INDEX IF NOT EXISTS idx_patches_source_packageid_version
  ON patches (source, package_id, version) WHERE package_id IS NOT NULL;
