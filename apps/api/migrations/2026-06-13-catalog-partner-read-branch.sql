-- 2026-06-13-catalog-partner-read-branch.sql
-- Sorts AFTER 2026-06-13-catalog-partner-axis-rls.sql ("-catalog-partner-r" >
-- "-catalog-partner-a"), so the dual-axis SELECT policies created there exist
-- by the time this file drops/recreates them.
--
-- The catalog dual-axis SELECT policy (from -catalog-partner-axis-rls.sql)
-- reads:
--   breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id) [OR <system flag>]
-- A partner-wide catalog row is (org_id NULL, partner_id = P). For an
-- ORGANIZATION-scope user, accessible_partner_ids is [] so
-- breeze_has_partner_access(P) is FALSE and breeze_has_org_access(NULL) is
-- FALSE — the org user CANNOT see their own MSP's partner-wide scripts, which
-- defeats the feature (org users should SEE + EXECUTE the MSP's shared scripts
-- but NOT edit them).
--
-- Fix: add a READ-ONLY own-partner branch to ONLY the SELECT policy of each
-- catalog table:
--   OR (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
-- breeze_current_partner_id() reads the breeze.current_partner_id GUC = the
-- caller's OWN partner (set for every scope, distinct from accessible_partner_ids
-- which governs partner-axis WRITE/admin). INSERT/UPDATE/DELETE policies are
-- LEFT UNCHANGED so writes stay locked to partner/system scope (the route guard
-- already blocks org-user writes). Cross-partner remains fully isolated.
--
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP POLICY IF EXISTS then CREATE.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

-- ============================================================
-- 1. breeze_current_partner_id() — reads breeze.current_partner_id GUC.
--    Mirrors the attributes/style of breeze_accessible_partner_ids() after its
--    2026-05-18-a parallel-safe rewrite: plpgsql, STABLE PARALLEL SAFE, regex
--    pre-validation (no EXCEPTION subtransaction), fail-closed → NULL.
--    Returns NULL when empty/missing/malformed so the read branch simply
--    doesn't apply (a NULL = partner_id comparison is never TRUE).
-- ============================================================
CREATE OR REPLACE FUNCTION public.breeze_current_partner_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.current_partner_id', true);
  IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
  IF raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN raw::uuid;
  END IF;
  RETURN NULL;
END;
$function$;

-- Best-effort LEAKPROOF (requires superuser). Mirror the pattern used by the
-- sibling helpers (2026-05-17-e / 2026-05-18-a).
DO $$
BEGIN
  ALTER FUNCTION public.breeze_current_partner_id() LEAKPROOF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipped LEAKPROOF on breeze_current_partner_id (requires superuser); PARALLEL SAFE applied.';
END $$;

-- ============================================================
-- 2. Extend ONLY the SELECT policy of each catalog table with the read-only
--    own-partner branch. Keep each table's existing system flag.
--    INSERT/UPDATE/DELETE policies are untouched.
-- ============================================================

-- scripts (has is_system)
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.scripts;
CREATE POLICY breeze_dual_axis_select ON public.scripts FOR SELECT
  USING (
    public.breeze_has_org_access(org_id)
    OR public.breeze_has_partner_access(partner_id)
    OR is_system
    OR (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
  );

-- alert_templates (has is_built_in)
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.alert_templates;
CREATE POLICY breeze_dual_axis_select ON public.alert_templates FOR SELECT
  USING (
    public.breeze_has_org_access(org_id)
    OR public.breeze_has_partner_access(partner_id)
    OR is_built_in
    OR (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
  );

-- script_categories (no system flag)
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.script_categories;
CREATE POLICY breeze_dual_axis_select ON public.script_categories FOR SELECT
  USING (
    public.breeze_has_org_access(org_id)
    OR public.breeze_has_partner_access(partner_id)
    OR (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
  );

-- script_tags (no system flag)
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.script_tags;
CREATE POLICY breeze_dual_axis_select ON public.script_tags FOR SELECT
  USING (
    public.breeze_has_org_access(org_id)
    OR public.breeze_has_partner_access(partner_id)
    OR (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
  );
