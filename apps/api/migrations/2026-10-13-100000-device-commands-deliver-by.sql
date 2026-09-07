-- 2026-10-13-100000: deferred delivery for device commands (#5128).
--
-- deliver_by is the DELIVERY deadline: the instant by which an agent must have
-- claimed the row (pending -> sent). It is separate from the execution timeout
-- (services/commandTimeouts.ts), which the stale reaper applies to `sent` rows
-- from executed_at. NULL keeps today's rule for rows created before this
-- migration, so no backfill is needed and old pending rows behave as before.
--
-- submitted_org_id is PROVENANCE, NOT TENANCY. device_commands is intentionally
-- system-scoped (agent WS path, no RLS -- see CLAUDE.md). This column records the
-- device's org at enqueue so claim-time eligibility can cancel rows whose device
-- has since moved org. It is deliberately not named org_id: the RLS-coverage and
-- cascade contract tests auto-discover `org_id` columns, and this table must
-- not be reclassified as tenant-scoped. ON DELETE SET NULL so erasing an org a
-- device has LEFT is never blocked by that device's historical rows.
--
-- DDL only: no DML, so no set_config('breeze.scope', 'system', true) is needed
-- (migrationRlsScope.test.ts).

ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS deliver_by timestamptz;

ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS submitted_org_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'device_commands_submitted_org_id_fkey'
      AND conrelid = 'device_commands'::regclass
  ) THEN
    ALTER TABLE device_commands
      ADD CONSTRAINT device_commands_submitted_org_id_fkey
      FOREIGN KEY (submitted_org_id) REFERENCES organizations(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Reaper scan for due deliveries; partial so 7-day rows are not rescanned
-- every 2 minutes and so the index stays small relative to the table.
CREATE INDEX IF NOT EXISTS idx_device_commands_deliver_by
  ON device_commands (deliver_by)
  WHERE status = 'pending' AND deliver_by IS NOT NULL;
