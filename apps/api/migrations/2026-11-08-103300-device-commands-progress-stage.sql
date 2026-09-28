-- #3578: in-flight progress for agent commands.
--
-- A software install sat on "Pending" for up to 45 minutes (15 min download +
-- 30 min install on the agent) with nothing to tell a healthy long install
-- apart from a lost command. Agents that advertise support now send a
-- `command_progress` WS frame at each stage transition (downloading ->
-- installing); the server records the latest stage on the command row itself,
-- keyed by command id, so a retry (a new device_commands row) can never
-- inherit a superseded attempt's stage.
--
-- Both columns are nullable and advisory: nothing gates on them, terminal
-- state stays in `status`, and rows from older agents simply keep NULL.
-- device_commands is intentionally system-scoped (no org_id, no RLS), so no
-- policy, cascade or export-policy change applies.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No data is written.

ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS progress_stage varchar(32);
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS progress_at timestamptz;
