-- Evidence reports for service plans (#5784) W01, OD-12.
-- Portal visibility of a managed evidence run is DERIVED: a completed run is
-- visible when no deliverable evidence row references it, or when a referencing
-- row's occurrence is 'delivered'. Both portal predicates and the scorecard's
-- publishableEvidence look the run up by report_run_id, which had no index --
-- sd_evidence_occurrence_idx and sd_evidence_org_idx are the only two today.
-- DDL only: no rows are written.

CREATE INDEX IF NOT EXISTS sd_evidence_report_run_idx
  ON service_deliverable_evidence (report_run_id)
  WHERE report_run_id IS NOT NULL;
