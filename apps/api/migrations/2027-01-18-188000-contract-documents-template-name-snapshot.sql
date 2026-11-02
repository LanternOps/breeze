-- #10294 follow-up: freeze the template name on the signed agreement.
--
-- The signature certificate, the portal signed-agreements list and the
-- signed-copy email named a signed agreement from the LIVE
-- contract_templates.name, so renaming a template rewrote the certificate on
-- every agreement already signed from it. Signed evidence must not change:
-- contract_documents.template_name_snapshot holds the name as it was at
-- signing, written by the single insert site (freezeSignedAgreement).
--
-- Nullable on purpose: during a rolling deploy an instance still on the old
-- code inserts without it, and readers fall back to the live name on NULL.
--
-- Backfill: existing rows get the CURRENT template name, which is what their
-- certificates show today. A template renamed before this migration ran keeps
-- its current name, not its original one (the original survives only as the
-- heading drawn into an authored template's frozen PDF bytes).
--
-- contract_documents carries no breeze_partner_export_* triggers, so the
-- backfill needs no partner-export pre-locks.
--
-- APPEND-ONLY GUARD: 2027-01-06-170000-contract-documents-append-only.sql
-- freezes every column (new ones included) for every role, the owner too, so
-- this one-off back-fill disables contract_documents_block_update around its
-- UPDATE, as that file's header requires of an evidence back-fill. Why it is
-- safe: the UPDATE writes only template_name_snapshot, only where it is still
-- NULL (never overwriting a value), and the guard is re-enabled in the same
-- transaction autoMigrate wraps this file in, so no other session ever sees it
-- off (DISABLE TRIGGER holds a SHARE ROW EXCLUSIVE lock until commit). Once
-- set, the guard freezes the snapshot like any other evidence column. The
-- guard function itself is not changed.

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE contract_documents
  ADD COLUMN IF NOT EXISTS template_name_snapshot varchar(255);

ALTER TABLE contract_documents DISABLE TRIGGER contract_documents_block_update;

DO $$
DECLARE n integer;
BEGIN
  UPDATE contract_documents cd
     SET template_name_snapshot = ct.name
    FROM contract_templates ct
   WHERE ct.id = cd.template_id
     AND cd.template_name_snapshot IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'contract_documents.template_name_snapshot backfilled on % row(s)', n;
END $$;

ALTER TABLE contract_documents ENABLE TRIGGER contract_documents_block_update;
