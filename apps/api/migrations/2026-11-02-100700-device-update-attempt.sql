-- #4073: record the agent self-update currently being attempted so a stuck
-- update (retrying forever, possibly with zero logs shipped) is detectable
-- server-side. Stamped by the WS `update_status` message, cleared by the
-- heartbeat on convergence. Nullable, no default: metadata-only ALTER on the
-- hot devices table, no rows written. Existing RLS policies on devices cover
-- the new columns.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS update_attempt_target_version varchar(50);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS update_attempt_started_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS update_attempt_last_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS update_attempt_count integer;
