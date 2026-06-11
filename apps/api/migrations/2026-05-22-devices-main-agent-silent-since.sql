-- #800 Layer C: server-side detection of main-agent silence while
-- watchdog stays online. Add a nullable timestamp column that the
-- heartbeat handler sets on the watchdog branch when the asymmetry
-- exists, and clears on the main agent branch when the agent recovers.
--
-- Safe migration: nullable column, no default, no index — the per-row
-- update happens only at heartbeat time so we don't need a hot-path
-- index for now.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS main_agent_silent_since TIMESTAMPTZ;
