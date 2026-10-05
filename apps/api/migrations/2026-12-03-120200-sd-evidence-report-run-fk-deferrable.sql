-- #7443: make sd_evidence_report_run_fk DEFERRABLE INITIALLY IMMEDIATE.
--
-- 2026-10-15-170000-service-deliverables.sql created
--   service_deliverable_evidence (report_run_id, report_id)
--     -> report_runs (id, report_id) ON DELETE CASCADE
-- NOT DEFERRABLE, unlike every other composite FK in that file. The org-merge
-- reports pass re-homes a dropped duplicate definition's runs onto the
-- survivor's definition (`UPDATE report_runs SET report_id = <survivor def>`)
-- and re-points the citing evidence rows' report_id in a separate statement.
-- Whichever runs first leaves the pair mismatched until the other lands, so a
-- non-deferrable constraint aborts the whole merge with 23503 the moment one
-- merged-away run is cited as deliverable evidence. Org merge runs under
-- SET CONSTRAINTS ALL DEFERRED, which this makes effective here.
--
-- INITIALLY IMMEDIATE keeps the check at end of statement for every other
-- writer; only a transaction that explicitly defers constraints (org merge)
-- moves it to commit. ALTER CONSTRAINT only flips the constraint triggers'
-- deferrability: no rewrite and no re-validation scan.
--
-- DDL only: no rows are written, so no breeze.scope election. Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'sd_evidence_report_run_fk'
       AND conrelid = 'service_deliverable_evidence'::regclass
       AND NOT condeferrable
  ) THEN
    ALTER TABLE service_deliverable_evidence
      ALTER CONSTRAINT sd_evidence_report_run_fk DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
