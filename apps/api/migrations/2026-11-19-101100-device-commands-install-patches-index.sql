-- @no-transaction
-- Per-device install_patches lookups for the patch install-failure overlay (#7680).
--
-- services/patchInstallFailures.ts now reads per-device `install_patches`
-- commands (the device Patches tab's Install button, vulnerability
-- remediation) as install attempts, on the device Patches tab AND on the
-- fleet patch list. The fleet read is org/partner-scoped, so it probes
-- `device_commands` for every device with an outstanding patch on the page.
-- `device_commands` has no index on `type`, and install_patches is a small
-- fraction of a device's commands — without this, each probe walks every
-- command the device received in the 90-day lookback.
--
-- No data change, no tenancy change: device_commands stays system-scoped (no
-- org_id column), so no RLS policy, cascade or export-policy entry applies.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): device_commands is
-- written on the agent hot path, and a non-concurrent build would take a
-- SHARE lock and stall fleet-wide agent writes for the build's duration
-- (same reasoning as 2026-09-10-device-command-uninstall-provenance.sql).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_install_patches_device_created
  ON device_commands (device_id, created_at DESC)
  WHERE type = 'install_patches';
