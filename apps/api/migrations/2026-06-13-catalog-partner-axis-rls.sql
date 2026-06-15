-- 2026-06-13-catalog-partner-axis-rls.sql
-- Catalog tables (scripts, script_categories, script_tags, alert_templates)
-- gain a partner_id axis so a record can be "available to all my orgs"
-- (org_id NULL, partner_id set) while staying tenant-isolated. Without
-- partner_id an org_id-NULL row is invisible to its owner AND visible across
-- partners (breeze_has_org_access(NULL)=FALSE) — the custom_field_definitions
-- trap (2026-06-11-i). Convert each table to a dual-axis policy:
--   org access OR partner access [OR system flag, where the table has one].
-- scripts -> is_system; alert_templates -> is_built_in;
-- script_categories/script_tags -> no system flag.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS, recreate.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

-- ============================================================
-- 1. Columns
-- ============================================================
ALTER TABLE scripts            ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE script_categories  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE script_tags        ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE alert_templates    ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- ============================================================
-- 2. Backfill partner_id from the owning org for org-specific rows.
--    System/built-in rows (org_id NULL) keep partner_id NULL.
--    Log counts for the forensic trail (even when 0).
-- ============================================================
DO $$
DECLARE n integer;
BEGIN
  UPDATE scripts s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % scripts row(s)', n;

  UPDATE script_categories s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % script_categories row(s)', n;

  UPDATE script_tags s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % script_tags row(s)', n;

  UPDATE alert_templates s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % alert_templates row(s)', n;
END $$;

-- ============================================================
-- 3. Dual-axis policies. Drop prior org-only policies, recreate.
-- ============================================================

-- scripts (has is_system)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.scripts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.scripts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.scripts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.scripts;
ALTER TABLE public.scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scripts FORCE ROW LEVEL SECURITY;
-- is_system gates READ visibility only (system scripts are globally readable),
-- NOT write access. It must NEVER appear in an INSERT/UPDATE/DELETE predicate:
-- `OR is_system` in WITH CHECK would let any tenant forge a row with
-- is_system=true and have it execute/appear across every partner's orgs
-- (cross-tenant script injection — Discussion #633, scripts-system-rls test).
-- Legitimate system scripts are seeded under system scope, where
-- breeze_has_org_access(...) already returns TRUE, so writes stay covered.
CREATE POLICY breeze_dual_axis_select ON public.scripts FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_system);
CREATE POLICY breeze_dual_axis_insert ON public.scripts FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.scripts FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.scripts FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));

-- alert_templates (has is_built_in)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.alert_templates;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.alert_templates;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.alert_templates;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.alert_templates;
ALTER TABLE public.alert_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_templates FORCE ROW LEVEL SECURITY;
-- is_built_in gates READ visibility only (built-in templates are globally
-- readable), NOT write access — same rule as scripts.is_system above. Keeping
-- it out of the write predicates stops a tenant from forging a globally-visible
-- is_built_in=true row; system-scope seeding stays covered by breeze_has_org_access.
CREATE POLICY breeze_dual_axis_select ON public.alert_templates FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_built_in);
CREATE POLICY breeze_dual_axis_insert ON public.alert_templates FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.alert_templates FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.alert_templates FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));

-- script_categories (no system flag)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_categories;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_categories;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_categories;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.script_categories;
ALTER TABLE public.script_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_dual_axis_select ON public.script_categories FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON public.script_categories FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.script_categories FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.script_categories FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));

-- script_tags (no system flag)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_tags;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_tags;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_tags;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.script_tags;
ALTER TABLE public.script_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_dual_axis_select ON public.script_tags FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON public.script_tags FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.script_tags FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.script_tags FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
