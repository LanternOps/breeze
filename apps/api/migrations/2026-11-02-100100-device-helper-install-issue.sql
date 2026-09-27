-- #6925: persist per-device "Breeze Assist enabled but not installed" state
-- reported by the agent heartbeat, so a device waiting on a helper offer the
-- server never sends (#6920 root cause) is visible in the UI. Nullable, no
-- default: metadata-only ALTER on the hot devices table. Existing RLS policies
-- on devices cover the new columns. Writes no rows.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS helper_install_issue varchar(50);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS helper_install_issue_since timestamptz;
