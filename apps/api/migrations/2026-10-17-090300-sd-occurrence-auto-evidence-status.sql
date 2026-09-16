-- Evidence reports for service plans (#5784) W01, OD-5 companion.
-- Auto-evidence refusals are a console.warn today (deliverableAutoEvidence.ts):
-- the occurrence stays open, is retried nightly, and becomes 'missed' after grace
-- with nothing anywhere saying why. These two columns make the last attempt and
-- its outcome queryable, and are what de-duplicates the internal ticket comment
-- so a nightly sweep does not spam the ticket with the same reason.
-- Plain text, not an enum: the refusal vocabulary is owned by
-- AutoEvidenceRefusal in TypeScript and grows without a migration.
-- DDL only: no rows are written.

ALTER TABLE service_deliverable_occurrences
  ADD COLUMN IF NOT EXISTS auto_evidence_attempted_at TIMESTAMPTZ;

ALTER TABLE service_deliverable_occurrences
  ADD COLUMN IF NOT EXISTS auto_evidence_refusal TEXT;

COMMENT ON COLUMN service_deliverable_occurrences.auto_evidence_refusal IS
  'Last auto-evidence refusal reason (AutoEvidenceRefusal), NULL when the last attempt succeeded or none has run (#5784).';
