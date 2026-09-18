-- Evidence reports for service plans (#5784) W01.
-- Partner-wide template linkage: a TYPE, never an id. A partner-wide item has
-- org_id IS NULL and reports.org_id is NOT NULL, so the composite FK
-- (report_id, org_id) -> reports(id, org_id) can never be satisfied for it.
-- The type resolves per target org in applyTemplateSet (spec §5.2, OD-6 = A).
-- DDL only: no rows are written, so no breeze.scope election is required.

ALTER TABLE deliverable_template_items
  ADD COLUMN IF NOT EXISTS auto_evidence_report_type report_type;

COMMENT ON COLUMN deliverable_template_items.auto_evidence_report_type IS
  'Managed evidence report type resolved per target org at applyTemplateSet time (#5784). NULL = no auto-evidence.';
