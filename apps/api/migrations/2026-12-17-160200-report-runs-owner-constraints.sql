-- #4247 step 3/4: report_runs owner constraints, validated before the policy
-- switch (160300).
--
--  * report_runs_one_owner_chk — exactly one owner axis, like reports_one_owner_chk.
--  * report_runs_report_org_fk / report_runs_report_partner_fk — the run's
--    owner IS its parent's owner. MATCH SIMPLE: the org FK is not checked for
--    a partner-owned run (org_id NULL) and vice versa; the XOR check makes
--    exactly one of them apply to every row.
--
-- Both FKs are DEFERRABLE INITIALLY IMMEDIATE (CLAUDE.md tenancy contract):
-- org merge runs SET CONSTRAINTS ALL DEFERRED and re-points reports.org_id and
-- report_runs.org_id in separate statements. ON DELETE CASCADE matches
-- report_runs_report_id_reports_id_fk (2026-10-27-130100).
--
-- Each constraint is added NOT VALID and validated in a separate statement.
-- Idempotent; writes no rows.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'report_runs_one_owner_chk' AND conrelid = 'public.report_runs'::regclass
  ) THEN
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL)) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'report_runs_report_org_fk' AND conrelid = 'public.report_runs'::regclass
  ) THEN
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_report_org_fk
      FOREIGN KEY (report_id, org_id) REFERENCES reports (id, org_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'report_runs_report_partner_fk' AND conrelid = 'public.report_runs'::regclass
  ) THEN
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_report_partner_fk
      FOREIGN KEY (report_id, partner_id) REFERENCES reports (id, partner_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE
      NOT VALID;
  END IF;
END $$;

ALTER TABLE report_runs VALIDATE CONSTRAINT report_runs_one_owner_chk;
ALTER TABLE report_runs VALIDATE CONSTRAINT report_runs_report_org_fk;
ALTER TABLE report_runs VALIDATE CONSTRAINT report_runs_report_partner_fk;
