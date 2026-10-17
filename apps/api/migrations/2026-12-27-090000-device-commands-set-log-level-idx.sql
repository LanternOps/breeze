-- @no-transaction
-- Per-device set_log_level lookup for the logs-not-arriving check (#8612).
--
-- services/logsNotArriving.ts reads a device's most recent completed
-- `set_log_level` command on every device-detail load where the device is
-- online and reports a log-shipping state — after W03 that is nearly every
-- online device. `device_commands` has no general device_id index, so without
-- this the lookup is a sequential scan that grows with the whole table.
--
-- No data change, no tenancy change: device_commands stays system-scoped (no
-- org_id column), so no RLS policy, cascade or export-policy entry applies.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): device_commands is
-- written on the agent hot path, and a non-concurrent build would take a
-- SHARE lock and stall fleet-wide agent writes for the build's duration
-- (same reasoning as 2026-11-19-101100-device-commands-install-patches-index.sql).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_set_log_level_device_completed
  ON device_commands (device_id, completed_at DESC)
  WHERE type = 'set_log_level';
