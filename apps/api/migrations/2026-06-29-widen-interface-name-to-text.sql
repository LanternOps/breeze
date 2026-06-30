-- Widen interface_name columns from varchar(100) to text.
--
-- Real Windows adapter names/descriptions (virtual adapters, VPN/Hyper-V/WSL/
-- vendor NICs) routinely exceed 100 chars. The agent network sync writes the
-- same interface name to device_network and device_ip_history, so an over-length
-- value hard-errors the INSERT ("value too long for type character varying") and
-- the row is silently dropped — that adapter goes missing from the device's
-- network info (issue #2006). network_topology.interface_name is the same logical
-- field from the discovery path and is widened for consistency.
--
-- Widening varchar(100) -> text is a metadata-only change in Postgres (no table
-- rewrite, no data loss) and is idempotent: re-running on an already-text column
-- is a no-op.

ALTER TABLE device_network    ALTER COLUMN interface_name TYPE text;
ALTER TABLE device_ip_history ALTER COLUMN interface_name TYPE text;
ALTER TABLE network_topology  ALTER COLUMN interface_name TYPE text;
