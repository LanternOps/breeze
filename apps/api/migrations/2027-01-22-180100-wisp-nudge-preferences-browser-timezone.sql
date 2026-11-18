-- #10402: the zone the user's browser reports, used to place the morning brief
-- when the user chose no zone and has no phone registered (previously UTC, so a
-- web-only user in Mountain time got a "morning" brief at 02:00 local).
--
-- A separate column, not brief_timezone: that one means "the user chose this"
-- and always wins, while this one is inferred and is refreshed when the browser
-- reports a different zone. The table is user-axis and already has its RLS
-- policies; a new column on it changes neither. No org_id, so no org-cascade or
-- export-policy registration applies.
--
-- Idempotent; no inner BEGIN/COMMIT. DDL only: it writes no rows, so it needs no
-- breeze.scope system election.

ALTER TABLE wisp_nudge_preferences ADD COLUMN IF NOT EXISTS browser_timezone text;
