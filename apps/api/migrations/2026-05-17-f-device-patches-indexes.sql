-- @no-transaction
-- device_patches scale indexes — table currently has only pkey + the
-- unique(device_id, patch_id) constraint. The unique index helps single-row
-- ON CONFLICT lookups but NOT the org-scoped or status-filtered reports.
-- Adds:
--   (org_id, status) — for org-scoped patch reports / compliance summaries
--   (device_id, status) — for per-device patch list filtered by status
--   (patch_id) — FK index for "all devices missing this patch" lookups
--
-- Uses CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so
-- the build does not take a SHARE lock on `device_patches` at deploy time.

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_patches_org_status_idx
  ON device_patches (org_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_patches_device_status_idx
  ON device_patches (device_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_patches_patch_id_idx
  ON device_patches (patch_id);
