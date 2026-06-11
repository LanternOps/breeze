-- 2026-06-11-i-custom-fields-dual-axis-rls.sql
-- custom_field_definitions carries org_id (org-axis) AND partner_id
-- (partner-axis) rows: the create route (routes/customFields.ts) inserts a
-- partner-wide field (org_id=NULL, partner_id set) whenever a partner-scoped
-- user supplies no orgId. But the table shipped org-only Shape-1 policies in
-- the squashed baseline (breeze_org_isolation_{select,insert,update,delete},
-- all WITH CHECK/USING breeze_has_org_access(org_id)). Since
-- breeze_has_org_access(NULL) = FALSE, every partner-scoped row was
-- structurally uncreatable AND invisible end-to-end:
--   insert into "custom_field_definitions" ... ->
--   PostgresError: new row violates row-level security policy
-- i.e. an Internal Server Error on "add custom field" for any partner/MSP user.
--
-- Convert to Shape-4 dual-axis (org OR partner), mirroring access_reviews
-- (2026-05-29) / deployment_invites (2026-04-20-b) / users. The two axes are
-- mutually exclusive (the route writes exactly one of org_id / partner_id), so
-- no composite FK applies.
-- Idempotent: DROP POLICY IF EXISTS then recreate. No inner BEGIN/COMMIT.
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.custom_field_definitions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.custom_field_definitions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.custom_field_definitions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.custom_field_definitions;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.custom_field_definitions;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.custom_field_definitions;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.custom_field_definitions;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.custom_field_definitions;
CREATE POLICY breeze_dual_axis_select ON public.custom_field_definitions FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON public.custom_field_definitions FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.custom_field_definitions FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.custom_field_definitions FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
