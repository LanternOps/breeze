-- 2026-05-29-access-reviews-dual-axis-rls.sql
-- Finding #7: access_reviews carries org_id (org-axis) AND partner_id
-- (partner-axis) rows but shipped org-only Shape-1 policies, so partner-axis
-- rows (org_id=NULL) fell back to an app-layer-only filter (fail-closed, no
-- leak) — violating the no-app-layer-only-RLS invariant. Convert to Shape-4
-- dual-axis (org OR partner). Mirrors deployment_invites (2026-04-20-b) /
-- users. Axes are mutually exclusive, so no composite FK applies.
-- Idempotent: DROP POLICY IF EXISTS then recreate. No inner BEGIN/COMMIT.
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.access_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.access_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.access_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.access_reviews;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.access_reviews;
CREATE POLICY breeze_dual_axis_select ON public.access_reviews FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON public.access_reviews FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.access_reviews FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.access_reviews FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
