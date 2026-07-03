-- Battery / power current-state telemetry for portable devices (#2142).
--
-- Stores the latest power snapshot reported by the agent heartbeat as a jsonb
-- blob on the devices row, alongside other per-heartbeat current state
-- (uptime_seconds, pending_reboot). Not a new tenant-scoped table — the devices
-- table already carries org_id + RLS — so no policy changes are needed here.
--
-- Shape (see BatteryStatus in packages/shared):
--   { present, percent?, chargingState?, pluggedIn?,
--     timeRemainingMinutes?, timeToFullMinutes?, reportedAt }
-- null column  = agent has never reported (old agent)
-- { present:false } = real no-battery desktop
--
-- Idempotent: ADD COLUMN IF NOT EXISTS makes re-application a no-op.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS battery_status jsonb;
