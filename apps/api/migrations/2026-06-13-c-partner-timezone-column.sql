-- First-class partner timezone (issue #1318).
--
-- Today the partner timezone lives only as a free-form, unvalidated key inside
-- the `partners.settings` JSONB blob, and nothing in the tz resolution chain
-- ever consults it. This promotes it to a real `partners.timezone` column so it
-- can be joined cheaply in `resolveDeviceTimezone` and constrained, while the
-- legacy `settings.timezone` key stays the UI write target (non-destructive —
-- we do NOT remove it here).
--
-- `partners` is a partner-axis tenant-scoped table that is already RLS-enabled +
-- forced with policies, so adding a plain column needs no new RLS policy (same
-- reasoning as 2026-06-09-users-disabled-reason.sql / 2026-06-11-j-device-
-- pending-reboot.sql). Idempotent: ADD COLUMN IF NOT EXISTS + a NULL-guarded
-- backfill, so re-applying is a no-op.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS timezone varchar(64) NOT NULL DEFAULT 'UTC';

-- Backfill the column from the existing JSONB key for partners that set one,
-- but only where the column is still at its 'UTC' default (so re-running, or a
-- later explicit column write, is never clobbered). The settings value is only
-- copied when it is a non-empty string; invalid IANA strings are left for the
-- application-layer resolver to skip rather than silently rewriting them here.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE partners
  SET timezone = settings->>'timezone'
  WHERE timezone = 'UTC'
    AND settings ? 'timezone'
    AND coalesce(settings->>'timezone', '') <> ''
    AND settings->>'timezone' <> 'UTC';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled partners.timezone from settings.timezone for % partner(s)', n;
  END IF;
END $$;
