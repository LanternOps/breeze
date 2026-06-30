-- Issue #2022: per-package detection rules for the Software Library.
--
-- Adds a nullable jsonb column to software_versions holding an array of
-- detection-rule clauses (registry / file_exists / msi_product_code) that the
-- agent evaluates against the device's real state to confirm whether the package
-- is actually installed — independent of the installer's exit code. Null/empty
-- preserves the prior exit-code-only behavior, so this is a backward-compatible
-- additive change requiring no backfill.
--
-- software_versions is a child of software_catalog (tenant ownership lives on the
-- catalog row); this column adds no new tenant axis, so no RLS change is needed.

ALTER TABLE software_versions
  ADD COLUMN IF NOT EXISTS detection_rules jsonb;
