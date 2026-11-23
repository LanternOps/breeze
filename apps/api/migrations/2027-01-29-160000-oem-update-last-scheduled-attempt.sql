-- device_oem_update_status.last_scheduled_attempt_at (#12266, feature #11065).
--
-- A Run Now set last_attempt_at, and the scheduler read last_attempt_at to allow
-- one run a night, so a technician's Run Now used up that night's scheduled run.
-- The scheduler now reads this column, which only a scheduled dispatch writes.
-- last_attempt_at keeps meaning "any run".
--
-- Plain timestamptz, no json/jsonb/bytea: classified `included` in
-- CORE_TENANT_EXPORT_POLICY. No RLS change: the table's policies are row-level.
--
-- Backfill, conservative: a row whose last run is not known to be a Run Now
-- (including a row with no linked command, or one retention has removed) keeps
-- the old behaviour for the night it was attempted (its last_attempt_at counts
-- as scheduled). Erring the other way could send a second scheduled run
-- on the night this ships. Idempotent: only rows still NULL are written.

ALTER TABLE device_oem_update_status
  ADD COLUMN IF NOT EXISTS last_scheduled_attempt_at timestamptz;

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE device_oem_update_status s
     SET last_scheduled_attempt_at = s.last_attempt_at
   WHERE s.last_scheduled_attempt_at IS NULL
     AND s.last_attempt_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM device_commands c
        WHERE c.id = s.last_command_id
          AND c.payload ->> 'trigger' = 'on_demand'
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE 'device_oem_update_status: backfilled last_scheduled_attempt_at on % rows', n;
  END IF;
END $$;
