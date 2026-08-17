-- Agent-observed available upgrade version, kept device- and tenant-scoped so scan data no longer rewrites global patches.version.

ALTER TABLE device_patches
  ADD COLUMN IF NOT EXISTS available_version varchar(64);
