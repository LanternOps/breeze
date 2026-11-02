-- @no-transaction
-- #8318 wave 2-1 — hardware hints, part 3 of 4: everything that must not run
-- inside one multi-table transaction. Each statement runs and commits on its
-- own.
--
-- 1. VALIDATE the two NOT VALID CHECKs on devices from 2027-01-19-110000,
--    under SHARE UPDATE EXCLUSIVE, so heartbeats keep writing `devices`
--    during the scan. That file backfilled every linked row first.
--
-- 2. The candidate search (services/reinstallCandidates) looks hardware up
--    partner-wide, so the org-leading device_hardware_org_serial_idx
--    (2026-10-10-100000) cannot serve it:
--      device_hardware_system_uuid_idx    the UUID match (canonical and
--                                         byte-swapped forms, `= ANY`).
--      device_hardware_serial_vendor_idx  the serial + manufacturer match, on
--                                         exactly the expressions the service
--                                         compares: upper(btrim(serial_number)),
--                                         lower(btrim(manufacturer)).
--    Both partial, so rows without the value cost nothing. CONCURRENTLY
--    because device_hardware is written by every hardware report.
--
-- lock_timeout bounds each VALIDATE's wait for its lock; it is RESET before the
-- CONCURRENTLY builds, which wait for older transactions without blocking
-- writers and must not be cut short. Idempotent: VALIDATE of a validated
-- constraint is a no-op; a failed CONCURRENTLY build leaves an INVALID index
-- that IF NOT EXISTS would skip, so the final DO block raises rather than
-- letting the file be recorded.
--
-- No row is written, so no system-scope election is needed. No tenancy change.

SET lock_timeout = '5s';

ALTER TABLE public.devices VALIDATE CONSTRAINT devices_possible_replacement_reason_values_chk;
ALTER TABLE public.devices VALIDATE CONSTRAINT devices_possible_replacement_reason_chk;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_hardware_system_uuid_idx
  ON public.device_hardware (system_uuid)
  WHERE system_uuid IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_hardware_serial_vendor_idx
  ON public.device_hardware (upper(btrim(serial_number)), lower(btrim(manufacturer)))
  WHERE serial_number IS NOT NULL AND manufacturer IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.device_hardware'::regclass
     AND c.relname IN ('device_hardware_system_uuid_idx', 'device_hardware_serial_vendor_idx')
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'device_hardware reinstall-hint index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
