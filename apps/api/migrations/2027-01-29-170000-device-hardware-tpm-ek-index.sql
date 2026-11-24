-- @no-transaction
-- #8318 wave T2 — TPM key evidence: the partner-wide lookup by endorsement-key
-- baseline. Detection (services/reinstallCandidates, `tpm_ek` evidence), its
-- pre-check after a first baseline (detectAfterKeyBaseline) and the
-- shared-key count of the evidence rule (services/deviceReattach/evidence.ts)
-- all look device_hardware up by tpm_ek_pub_sha256 across every org of a
-- partner, which no org-leading index serves.
--
-- Partial, so the many rows without a baseline cost nothing. CONCURRENTLY
-- because device_hardware is written by every hardware report. A failed
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would skip,
-- so the DO block raises rather than letting the file be recorded.
--
-- No row is written, so no system-scope election is needed. No tenancy change:
-- no new table or column.

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_hardware_tpm_ek_pub_sha256_idx
  ON public.device_hardware (tpm_ek_pub_sha256)
  WHERE tpm_ek_pub_sha256 IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.device_hardware'::regclass
       AND c.relname = 'device_hardware_tpm_ek_pub_sha256_idx'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'device_hardware_tpm_ek_pub_sha256_idx build left an INVALID index — DROP INDEX CONCURRENTLY it and re-apply this migration';
  END IF;
END $$;
