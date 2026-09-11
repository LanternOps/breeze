-- Console visibility for a scheduled end-user reboot (#3207 W5)
--
-- The agent's RebootManager already knows when a restart is scheduled, when its
-- hard deadline falls, what asked for it, and how much of the deferral budget
-- the end user has spent. None of that reached the server. These five columns
-- denormalize that state onto the device row from the heartbeat so a tech can
-- see "restart scheduled, postponed 1 of 3" without polling the agent.
--
-- SCALARS, deliberately. `devices` is in CORE_ORG_CASCADE_DELETE_ORDER, so every
-- column has to be classified in CORE_TENANT_EXPORT_POLICY, and CLAUDE.md forces
-- any json/jsonb/bytea column into `excludedOpen` — a jsonb blob here would mean
-- the reboot status never appears in a tenant export at all. Five scalars
-- classify as `included`. Do not "tidy" these into one jsonb column later.
--
-- ALL NULLABLE, no defaults. NULL is load-bearing: it means "this agent has
-- never reported reboot status" (pre-#3207 build), which the console must be
-- able to tell apart from "a restart is scheduled and cannot be postponed"
-- (reboot_max_deferrals = 0). A NOT NULL DEFAULT would erase that distinction
-- and would also rewrite every row in the table on a large fleet.
--
-- Tenancy: no new table, so no RLS policy, no cascade-list entry and no
-- allowlist change. `devices` already has RLS enabled + forced with an org_id
-- policy, and is already registered in CORE_ORG_CASCADE_DELETE_ORDER
-- (tenantCascade.ts) and CORE_DEVICE_CASCADE_DELETE_TABLES (routes/devices/
-- core.ts). Verified by grep, not assumed. The one registration that DOES fire
-- on a new column is the export policy — see tenantExportPolicyRegistry.ts in
-- this same commit.
--
-- No index. Nothing filters or sorts on these yet (the badge is rendered from a
-- row the console has already fetched by id), and an index on a column written
-- by every heartbeat is a write-amplification cost with no reader. Add one with
-- the query that needs it.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS reboot_scheduled_at timestamptz;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS reboot_deadline timestamptz;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS reboot_source varchar(32);

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS reboot_deferrals_used integer;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS reboot_max_deferrals integer;

-- Non-negativity only, on purpose.
--
-- The real range check (0..MAX_REBOOT_DEFERRALS) lives in the heartbeat zod
-- schema, where a violation degrades to "drop this optional field" instead of
-- failing the whole beat. Encoding the upper bound here too would turn a future
-- policy change that raises the ceiling into a 500 on every heartbeat from an
-- already-scheduled device — a constraint that can only ever fire on a value
-- the server itself decided to allow. Non-negativity, by contrast, is a true
-- invariant: neither counter can legitimately go below zero.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_reboot_deferrals_used_chk'
  ) THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_reboot_deferrals_used_chk
      CHECK (reboot_deferrals_used IS NULL OR reboot_deferrals_used >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_reboot_max_deferrals_chk'
  ) THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_reboot_max_deferrals_chk
      CHECK (reboot_max_deferrals IS NULL OR reboot_max_deferrals >= 0);
  END IF;
END $$;

COMMENT ON COLUMN devices.reboot_scheduled_at IS
  'When the agent''s RebootManager will fire the pending restart (#3207 W5). NULL = no restart scheduled, or the agent predates reboot-status reporting.';
COMMENT ON COLUMN devices.reboot_deadline IS
  'Absolute cutoff past which the restart fires regardless of remaining deferrals (#3207 W5).';
COMMENT ON COLUMN devices.reboot_source IS
  'What asked for the restart: patch_job, maintenance_window, manual (#3207 W5).';
COMMENT ON COLUMN devices.reboot_deferrals_used IS
  'How many times the end user has postponed this restart (#3207 W5).';
COMMENT ON COLUMN devices.reboot_max_deferrals IS
  'Deferral budget in force for THIS schedule (#3207 W5). 0 = cannot be postponed; NULL = agent predates deferral reporting. Read from the agent, not the policy, because the policy can change after a restart is already scheduled.';
