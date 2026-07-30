-- Resolved helper lifecycle mode reported by agents ("always-on" | "on-demand").
-- On-demand marks RD Session Hosts; the web UI keys session-targeting UX off it.
-- Nullable: old agents and non-Windows devices never report one.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS helper_lifecycle_mode varchar(20);
