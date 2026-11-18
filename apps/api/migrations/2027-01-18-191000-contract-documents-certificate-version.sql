-- #10513: version the signature certificate's wording.
--
-- The certified copy's certificate page is derived on demand
-- (services/agreementCertificate.ts), so changing its wording would silently
-- rewrite the certificate of every agreement already signed. Signed evidence
-- must not change after the fact. contract_documents.certificate_version
-- records, at signing, which wording version the agreement renders with:
--
--   NULL — v1: every agreement signed before this migration. Its token-link
--          acceptance keeps printing "via emailed link".
--   2    — the token-link acceptance prints "via signing link" (the link may
--          have been copied and shared, not emailed).
--
-- NO BACKFILL, and the append-only guard is not touched: NULL already means
-- v1, so existing rows are correct as they stand. The column is added WITHOUT
-- a default first (existing rows stay NULL — an ADD COLUMN ... DEFAULT 2 would
-- stamp them v2 and rewrite their certificates), and the default is set in a
-- separate statement, which affects future inserts only. The default covers
-- an instance still on older code inserting during a rolling deploy; the
-- application (freezeSignedAgreement) writes the version explicitly.
--
-- Once written, contract_documents_block_update (2027-01-06-170000) freezes
-- the column like every other evidence column — no UPDATE grant is added.
--
-- The CHECK keeps NULL the only encoding of v1 (a stored 1 would be a second
-- spelling of the same thing) and rejects nonsense values.
--
-- ROLLBACK: code older than #10513 ignores this column, so a code rollback
-- re-labels v2 documents "via emailed link" until #10513 is redeployed; v1
-- rows are unaffected either way. The column itself is additive and nullable.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, SET DEFAULT is re-runnable, the CHECK
-- is added only when absent. Writes no rows.

ALTER TABLE contract_documents
  ADD COLUMN IF NOT EXISTS certificate_version smallint;

ALTER TABLE contract_documents
  ALTER COLUMN certificate_version SET DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'contract_documents_certificate_version_chk'
       AND conrelid = 'public.contract_documents'::regclass
  ) THEN
    ALTER TABLE contract_documents
      ADD CONSTRAINT contract_documents_certificate_version_chk
      CHECK (certificate_version IS NULL OR certificate_version >= 2);
  END IF;
END $$;
