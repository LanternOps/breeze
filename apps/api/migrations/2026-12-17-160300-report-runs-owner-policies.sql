-- #4247 step 4/4: report_runs RLS — FK-child EXISTS join → direct dual-axis.
--
-- Replaces the four per-command breeze_org_isolation_* policies (an EXISTS
-- join on the parent report, last written by 2026-10-27-130100) with ONE
-- FOR ALL owner policy on the run's own columns, the same shape as
-- reports_owner_isolation. Runs only after 160200 validated that every row's
-- owner equals its parent's, so visibility is unchanged row for row.
--
-- Deliberately NO partner-wide SELECT branch (`org_id IS NULL AND partner_id =
-- breeze_current_partner_id()`): a run of a partner-owned report carries the
-- same cross-org aggregate as its parent, which reports keeps illegible to
-- org sessions (2026-10-27-130100 header). Runs match the parent.
--
-- The report-history read branch (2026-10-28-130000) stays SELECT-only and is
-- rewritten on the run's own org_id. No INSERT/UPDATE/DELETE policy admits a
-- history org, so writes under that capability still fail (42501) or match
-- nothing.
--
-- report_run_deliveries keeps its own policies (they reach the owner through
-- the run's parent report and remain correct). Idempotent; writes no rows.

ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON report_runs;

DROP POLICY IF EXISTS report_runs_owner_isolation ON report_runs;
CREATE POLICY report_runs_owner_isolation ON report_runs
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS report_runs_report_history_select ON public.report_runs;
CREATE POLICY report_runs_report_history_select ON public.report_runs
  FOR SELECT
  USING (org_id IS NOT NULL AND public.breeze_has_report_history_access(org_id));
