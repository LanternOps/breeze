-- Security review (2026-04-11): restrict writes on system-wide cis_check_catalog
-- to the 'system' scope. SELECT remains open (true) so all tenants can read the
-- shared catalog. Replaces the permissive WITH CHECK (true) write policies from
-- 0048-cis-hardening.sql as a defense-in-depth fix.

BEGIN;

DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.cis_check_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.cis_check_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.cis_check_catalog;

CREATE POLICY breeze_org_isolation_insert ON public.cis_check_catalog
  FOR INSERT WITH CHECK (public.breeze_current_scope() = 'system');

CREATE POLICY breeze_org_isolation_update ON public.cis_check_catalog
  FOR UPDATE USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');

CREATE POLICY breeze_org_isolation_delete ON public.cis_check_catalog
  FOR DELETE USING (public.breeze_current_scope() = 'system');

COMMIT;
