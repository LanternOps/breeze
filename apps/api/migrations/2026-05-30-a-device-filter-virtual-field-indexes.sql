-- Partial indexes backing the device-filter virtual EXISTS fields (#968):
--   patches.pending       -> device_patches WHERE status = 'pending'
--   alerts.critical       -> alerts WHERE status = 'active' AND severity = 'critical'
--   system.rebootRequired -> patch_job_results WHERE reboot_required AND rebooted_at IS NULL
-- All correlate on device_id, so lead the index with it. Plain CREATE INDEX
-- (autoMigrate wraps each file in a transaction; CONCURRENTLY is not allowed).

CREATE INDEX IF NOT EXISTS idx_device_patches_pending
  ON device_patches (device_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_alerts_active_critical
  ON alerts (device_id) WHERE status = 'active' AND severity = 'critical';

CREATE INDEX IF NOT EXISTS idx_patch_job_results_reboot_pending
  ON patch_job_results (device_id) WHERE reboot_required = true AND rebooted_at IS NULL;
