BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS software_versions_one_latest_per_catalog_idx
  ON software_versions (catalog_id)
  WHERE is_latest = true;

COMMIT;
