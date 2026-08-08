-- Installed breeze-backup version, reported by the agent's heartbeat.
-- Nullable: old agents and devices without the backup binary installed never
-- report one. Mirrors devices.watchdog_version (#1802).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS backup_version varchar(50);
