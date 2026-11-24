-- @no-transaction
-- #8318 wave T2 (review) — the shared-key count of the evidence rule
-- (services/deviceReattach/evidence.ts countOtherKeyHolders) also counts a
-- device holding the key as an unreviewed key change, so it looks
-- device_hardware up by tpm_ek_mismatch_sha256 as well as by the baseline
-- (2027-01-29-170000).
--
-- Partial: only devices with a held change have a row in it, which is rare.
-- CONCURRENTLY because device_hardware is written by every hardware report. A
-- failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would
-- skip, so the DO block raises rather than letting the file be recorded.
--
-- No row is written, so no system-scope election is needed. No tenancy change:
-- no new table or column.

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_hardware_tpm_ek_mismatch_sha256_idx
  ON public.device_hardware (tpm_ek_mismatch_sha256)
  WHERE tpm_ek_mismatch_sha256 IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.device_hardware'::regclass
       AND c.relname = 'device_hardware_tpm_ek_mismatch_sha256_idx'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'device_hardware_tpm_ek_mismatch_sha256_idx build left an INVALID index — DROP INDEX CONCURRENTLY it and re-apply this migration';
  END IF;
END $$;
