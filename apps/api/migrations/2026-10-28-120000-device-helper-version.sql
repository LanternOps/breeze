-- Installed Breeze Assist (user helper) version, reported by the agent's
-- heartbeat (#6751). The server already reads it to compute helperUpgradeTo;
-- persisting it makes a helper stuck behind the promoted release visible and
-- filterable in the portal. Nullable: old agents and devices without the
-- helper installed never report one. Mirrors devices.watchdog_version /
-- devices.backup_version. No backfill, no row writes.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS helper_version varchar(50);
