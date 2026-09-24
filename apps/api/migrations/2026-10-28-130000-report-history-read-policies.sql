-- #6771: read-only report history for an active partner's out-of-service orgs.
--
-- Product decision B (#6699 / #6716): an active MSP may READ report
-- definitions and run metadata of its own suspended, churned, offboarding or
-- archived orgs; generation, scheduling, exports and downloads stay refused.
--
-- Those orgs are never in `breeze.accessible_org_ids` (authMiddleware admits
-- only active/trial orgs, and must keep doing so — widening it would reopen
-- every endpoint for suspended tenants). The report-history GET routes instead
-- receive a separate, opt-in grant: the `breeze.report_history_org_ids` GUC,
-- computed by `computeReportHistoryReach` in the auth bootstrap from the
-- caller's OWN partner membership (active user, active partner, live
-- membership, reports:read, `selected` users intersected with their raw list,
-- soft-deleted orgs excluded) and written by `applyAccessContextGucs`.
--
-- This migration adds:
--   1. `breeze_report_history_org_ids()` — the GUC parser. Fails closed exactly
--      like `breeze_accessible_org_ids()` (2026-05-18-a): regex pre-validation,
--      no EXCEPTION block (parallel-safe), and ANY malformed entry empties the
--      WHOLE list. Unlike that helper there is no '*' wildcard: '*' is
--      malformed here, so it grants nothing.
--   2. `breeze_has_report_history_access(uuid)` — true only for a PARTNER-scope
--      context whose GUC lists the org. An organization-scope or system
--      context never gains anything from it.
--   3. Two ADDITIVE, `FOR SELECT`-only policies, on `reports` and
--      `report_runs` (the run policy reaches the org through its owning
--      report, like the existing FK-child policy). Permissive policies are
--      OR-ed per command, so these widen SELECT alone. The existing
--      `reports_owner_isolation` (FOR ALL) and `report_runs`
--      `breeze_org_isolation_*` policies are untouched: an INSERT under the
--      capability fails its WITH CHECK (42501) and an UPDATE/DELETE matches
--      no row, because no UPDATE/DELETE policy admits the history org.
--
-- Deliberately NOT granted: `report_run_deliveries` (recipient addresses),
-- `report_schedule_recipients` / `contacts` (live contact PII), and every
-- other org table. Devices, scripts, sites etc. of the inactive org stay
-- invisible — proven by reportHistoryRls.integration.test.ts.
--
-- Idempotent (CREATE OR REPLACE FUNCTION; DROP POLICY IF EXISTS + CREATE).
-- No inner BEGIN/COMMIT. Writes no rows, so no system-scope elevation.

CREATE OR REPLACE FUNCTION public.breeze_report_history_org_ids()
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.report_history_org_ids', true);
  IF raw IS NULL OR raw = '' THEN RETURN ARRAY[]::uuid[]; END IF;
  IF raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(,[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})*$' THEN
    RETURN string_to_array(raw, ',')::uuid[];
  END IF;
  RETURN ARRAY[]::uuid[];
END;
$function$;

CREATE OR REPLACE FUNCTION public.breeze_has_report_history_access(target_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
  SELECT target_org_id IS NOT NULL
     AND public.breeze_current_scope() = 'partner'
     AND target_org_id = ANY (public.breeze_report_history_org_ids());
$function$;

DROP POLICY IF EXISTS reports_report_history_select ON public.reports;
CREATE POLICY reports_report_history_select ON public.reports
  FOR SELECT
  USING (org_id IS NOT NULL AND public.breeze_has_report_history_access(org_id));

DROP POLICY IF EXISTS report_runs_report_history_select ON public.report_runs;
CREATE POLICY report_runs_report_history_select ON public.report_runs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.reports r
       WHERE r.id = report_runs.report_id
         AND r.org_id IS NOT NULL
         AND public.breeze_has_report_history_access(r.org_id)
    )
  );
