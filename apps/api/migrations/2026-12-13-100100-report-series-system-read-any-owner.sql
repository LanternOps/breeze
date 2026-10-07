-- report_series: a system-scope SELECT branch that applies to every role, so
-- the multi-org report series guard triggers work whichever role owns them.
--
-- The guards (2026-11-09-110000-report-series.sql,
-- 2026-11-09-110100-reports-series-children.sql) are SECURITY DEFINER and run
-- as the role that applied migrations. They elect breeze.scope = 'system'
-- around their read of report_series and restore the caller's scope after.
-- But report_series' only policy is `report_series_partner_access ... FOR ALL
-- TO breeze_app`, and a policy restricted to breeze_app does not apply to any
-- other role. Under FORCE ROW LEVEL SECURITY a migration role that is neither
-- superuser nor BYPASSRLS therefore read zero series rows even in system
-- scope, so:
--   * breeze_report_series_target_partner_guard and
--     breeze_report_series_child_partner_guard rejected every valid target and
--     series child with 23514;
--   * breeze_report_series_org_partner_guard saw no series and let an
--     organization change partner with series targets/children attached.
--
-- This policy is SELECT-only and system-scope-only, with no TO clause (same
-- shape as partner_llm_configs_system_only, 2026-11-14-100000). It grants
-- breeze_app nothing it does not already have (its own policy has the system
-- branch), opens no write path for any role, and confers no table privileges:
-- only a role already holding SELECT on report_series (its owner) gains the
-- system-scope read the guard functions rely on. The guard functions
-- themselves are unchanged.
--
-- DDL only, no rows written. Idempotent (DROP POLICY IF EXISTS + CREATE). No
-- inner BEGIN/COMMIT.
DROP POLICY IF EXISTS report_series_system_read ON public.report_series;
CREATE POLICY report_series_system_read ON public.report_series
  FOR SELECT
  USING (public.breeze_current_scope() = 'system');
