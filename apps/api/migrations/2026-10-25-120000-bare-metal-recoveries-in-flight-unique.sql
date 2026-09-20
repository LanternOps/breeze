-- #6322: `createBareMetalRecovery` enforced "one non-terminal recovery per
-- device" with SELECT-then-INSERT, so two concurrent creators could both pass
-- the check and both insert. Make the database the arbiter with a partial
-- unique index; the service maps the resulting 23505 to the same
-- `recovery_in_progress` 409 the pre-check already raised.
--
-- Terminal statuses mirror BARE_METAL_RECOVERY_TERMINAL in
-- apps/api/src/db/schema/bareMetalRecoveries.ts. Adding a terminal status
-- there requires a follow-up migration that rebuilds this index.

-- Pre-existing duplicates (from the SELECT-then-INSERT window this index
-- closes) would abort the CREATE UNIQUE INDEX below. Retire the older rows of
-- each device's non-terminal set, keeping the newest, and report the count so
-- the cleanup leaves a forensic trail even when it is zero.
DO $$
DECLARE
  cleaned integer;
BEGIN
  IF to_regclass('public.bare_metal_recoveries') IS NULL THEN
    RETURN;
  END IF;

  WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY device_id ORDER BY created_at DESC, id DESC) AS rn
    FROM bare_metal_recoveries
    WHERE status NOT IN ('checked_in', 'completed', 'failed', 'refused')
  )
  UPDATE bare_metal_recoveries r
  SET status = 'failed',
      failure_reason = COALESCE(r.failure_reason,
        'Superseded by a newer in-flight recovery for the same device (one-in-flight backfill, #6322)'),
      completed_at = COALESCE(r.completed_at, now()),
      updated_at = now()
  FROM ranked
  WHERE ranked.id = r.id AND ranked.rn > 1;

  GET DIAGNOSTICS cleaned = ROW_COUNT;
  IF cleaned > 0 THEN
    RAISE WARNING 'bare_metal_recoveries: failed % duplicate in-flight recovery row(s) before adding the one-in-flight unique index (#6322)', cleaned;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS bare_metal_recoveries_device_in_flight_idx
  ON bare_metal_recoveries (device_id)
  WHERE status NOT IN ('checked_in', 'completed', 'failed', 'refused');
