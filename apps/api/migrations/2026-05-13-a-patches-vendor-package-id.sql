-- Add vendor + package_id to support third-party patch metadata.
ALTER TABLE patches
  ADD COLUMN IF NOT EXISTS vendor varchar(255),
  ADD COLUMN IF NOT EXISTS package_id varchar(256);

CREATE INDEX IF NOT EXISTS patches_package_id_idx
  ON patches (package_id) WHERE package_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS patches_source_package_id_idx
  ON patches (source, package_id) WHERE package_id IS NOT NULL;
