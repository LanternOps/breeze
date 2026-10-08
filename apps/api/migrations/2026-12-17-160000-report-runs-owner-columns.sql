-- #4247 step 1/4: report_runs owner columns (dual-axis, mirrors reports).
--
-- report_runs had no tenancy column of its own: RLS reached the owner through
-- an EXISTS join on the parent `reports` row (2026-06-13-b, widened to the
-- partner axis by 2026-10-27-130100). Since #3198 W01 a report is owned by an
-- org XOR a partner, and partner-owned reports produce runs, so a run gets the
-- same two columns its parent has: org_id XOR partner_id, both nullable, always
-- equal to the parent's owner. Ownership means the parent's CURRENT owner, not
-- execution-time provenance (the execution_scope_* envelope keeps that).
--
-- This file only adds nullable columns, the composite-FK target key on
-- reports, owner indexes, and an owner-fill trigger. Backfill (160100),
-- constraints (160200) and the policy switch (160300) follow in that order.
--
-- Idempotent; no inner BEGIN/COMMIT; writes no rows (no scope elevation).

ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- Target of report_runs_report_partner_fk (160200). NON-partial on purpose,
-- like reports_id_org_id_uniq: a partial unique index cannot back a foreign
-- key. NULL partner_id keys are distinct in a B-tree unique index, so every
-- org-owned row coexists.
CREATE UNIQUE INDEX IF NOT EXISTS reports_id_partner_id_uniq ON reports (id, partner_id);

CREATE INDEX IF NOT EXISTS report_runs_org_id_idx ON report_runs (org_id);
CREATE INDEX IF NOT EXISTS report_runs_partner_id_idx ON report_runs (partner_id);

-- Owner fill. A run inserted without either owner column takes its parent's
-- owner, read in the INSERTING session's own RLS context (SECURITY INVOKER):
-- a session that cannot see the parent gets nothing filled, and the row is
-- then refused: by the owner policy's WITH CHECK (42501) for a tenant session,
-- by report_runs_one_owner_chk (23514, 160200) for system scope. It never overrides a
-- value the writer supplied — the composite FKs check those.
--
-- Why it exists alongside the explicit owner columns every application insert
-- site now writes: (1) a rolling deploy keeps old API containers inserting
-- runs without the columns between this migration and their replacement;
-- (2) any future insert path that forgets the columns still lands on the
-- parent's owner instead of being refused. INSERT only — there is
-- deliberately no BEFORE UPDATE trigger (org merge re-points org_id itself,
-- and orgMergeRegistry.integration.test.ts guards org_id UPDATE triggers).
CREATE OR REPLACE FUNCTION public.report_runs_fill_owner_from_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.org_id IS NULL AND NEW.partner_id IS NULL THEN
    SELECT r.org_id, r.partner_id
      INTO NEW.org_id, NEW.partner_id
      FROM public.reports r
     WHERE r.id = NEW.report_id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS report_runs_fill_owner ON report_runs;
CREATE TRIGGER report_runs_fill_owner
  BEFORE INSERT ON report_runs
  FOR EACH ROW EXECUTE FUNCTION public.report_runs_fill_owner_from_report();
