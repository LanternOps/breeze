-- Active-VPN-client presence telemetry for devices (#2139).
--
-- Stores the latest set of active VPN overlay clients reported by the agent's
-- periodic network inventory as a jsonb array on the devices row, alongside
-- other per-report current state (battery_status, uptime_seconds,
-- pending_reboot). Not a new tenant-scoped table — the devices table already
-- carries org_id + forced RLS — so no policy changes are needed here.
--
-- Shape (see VpnPresence in packages/shared):
--   [{ provider, active, interfaceName, ipv4?, ipv6?, dnsName?,
--      detectionSource, reportedAt }, ...]
-- null column = agent has never reported (old agent)
-- []          = reported, no active VPN detected
--
-- Read-only telemetry: no secrets, peer lists, keys, or VPN management.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS makes re-application a no-op.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS active_vpns jsonb;
