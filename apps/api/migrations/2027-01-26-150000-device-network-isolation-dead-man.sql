-- Non-sticky dead-man support (#10103), reported by the authenticated agent on every heartbeat as
-- securityCapabilities.networkIsolationDeadMan. The server sends a non-zero deadManSeconds only to a
-- device that reports it (and passes the dead-man version gate). Writes no rows.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_isolation_dead_man boolean NOT NULL DEFAULT false;
