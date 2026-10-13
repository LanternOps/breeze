-- #8620 (part of #8618 / #7583): agent-reported watchdog install health.
-- Three nullable columns, no default, no backfill: a metadata-only ALTER on
-- the hot devices table. NULL = not reported (healthy, old agent, or opted
-- out of nothing). State and error class are closed vocabularies written by
-- the heartbeat on transition only; since is the server-clock transition time.
-- Existing RLS policies on devices cover the new columns. No rows are written,
-- so no breeze.scope election is needed.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_install_state varchar(20);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_install_error_class varchar(20);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_install_since timestamptz;
