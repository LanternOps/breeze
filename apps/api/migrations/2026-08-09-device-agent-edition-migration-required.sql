-- Agent-reported build edition + migration-needed flag (heartbeat telemetry).
-- Non-sensitive; drives the self-hosted migration banner. Written unconditionally
-- every heartbeat (self-healing), so a resolved condition clears next beat.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_edition varchar(20);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS migration_required boolean NOT NULL DEFAULT false;
