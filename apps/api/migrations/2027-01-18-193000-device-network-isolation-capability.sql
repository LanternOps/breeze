-- Non-sticky network-isolation readiness, reported by the authenticated agent on every heartbeat.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_isolation_version integer NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_isolation_mechanism text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_isolation_unsupported_reason text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_isolation_ready boolean NOT NULL DEFAULT false;
