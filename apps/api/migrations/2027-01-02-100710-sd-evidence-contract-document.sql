-- #9312 step 2 of 2: service_deliverable_evidence.contract_document_id.
--
-- Evidence of kind 'contract_document' references the signed agreement row in
-- contract_documents — one source of truth for a signed legal record, rather
-- than a second copy in org_documents with its own retention and deletion.
--
-- 1. contract_documents gains a (id, org_id) unique key so the evidence FK can
--    be composite. id is already the primary key, so this cannot fail on
--    existing data; it exists only to be an FK target.
-- 2. The composite FK (contract_document_id, org_id) keeps an evidence row in
--    its agreement's org. DEFERRABLE INITIALLY IMMEDIATE like every composite
--    org FK: org merge re-points contract_documents and evidence org_id in
--    separate statements under SET CONSTRAINTS ALL DEFERRED. ON DELETE CASCADE
--    matches sd_evidence_document_org_fk / sd_evidence_report_org_fk.
-- 3. sd_evidence_kind_chk is re-created with a third arm: exactly one target
--    per kind. Every existing row satisfies the new form (contract_document_id
--    is NULL on all of them), so the re-validation scan cannot fail.
--
-- Tenancy: no new table; service_deliverable_evidence keeps its shape-1 RLS
-- policies. The new column is classified in CORE_TENANT_EXPORT_POLICY.
--
-- Idempotent. DDL only: no row writes, so no breeze.scope election.

CREATE UNIQUE INDEX IF NOT EXISTS contract_documents_id_org_uq
  ON contract_documents (id, org_id);

ALTER TABLE service_deliverable_evidence
  ADD COLUMN IF NOT EXISTS contract_document_id UUID;

DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_contract_document_org_fk
    FOREIGN KEY (contract_document_id, org_id) REFERENCES contract_documents(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE service_deliverable_evidence DROP CONSTRAINT IF EXISTS sd_evidence_kind_chk;
ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_kind_chk CHECK (
  (kind = 'document'          AND document_id IS NOT NULL AND report_id IS NULL AND report_run_id IS NULL AND contract_document_id IS NULL) OR
  (kind = 'report_run'        AND document_id IS NULL AND report_id IS NOT NULL AND report_run_id IS NOT NULL AND contract_document_id IS NULL) OR
  (kind = 'contract_document' AND document_id IS NULL AND report_id IS NULL AND report_run_id IS NULL AND contract_document_id IS NOT NULL)
);

-- FK lookups on agreement delete / org merge re-point.
CREATE INDEX IF NOT EXISTS sd_evidence_contract_document_idx
  ON service_deliverable_evidence (contract_document_id)
  WHERE contract_document_id IS NOT NULL;
