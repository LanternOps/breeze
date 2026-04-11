-- 2026-04-11: Fix roles RLS policies to handle partner-scope and system
-- roles correctly.
--
-- Background: migration 0008-tenant-rls.sql auto-enabled RLS on every
-- public table with an `org_id` column. `roles` has both `org_id` and
-- `partner_id` columns, both nullable. The auto-loop installed
-- policies keyed on `breeze_has_org_access(org_id)` only — which
-- evaluates to FALSE for rows where `org_id IS NULL` (system roles and
-- partner-scope roles). Under the BYPASSRLS `breeze` superuser this
-- didn't matter, but now that the app connects as the unprivileged
-- `breeze_app`, every JOIN through `roles` from partner-scope or
-- system-scope routes (e.g. `GET /users` listing partner admins)
-- returns zero rows.
--
-- The correct policy is dual-axis with a system-role carve-out:
--   - partner-scope caller sees roles where partner_id matches their
--     accessible_partner_ids (via breeze_has_partner_access), OR roles
--     where org_id matches their accessible_org_ids
--   - org-scope caller sees roles for their accessible orgs only
--   - system-scope caller sees everything (via breeze_has_org_access
--     short-circuit on system scope)
--   - Everyone with a real scope (not 'none') sees system roles, which
--     live as (is_system=true, partner_id IS NULL, org_id IS NULL) —
--     they're global templates used during signup and invite flows
--
-- Fully idempotent.

BEGIN;

DROP POLICY IF EXISTS breeze_org_isolation_select ON roles;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON roles;
DROP POLICY IF EXISTS breeze_org_isolation_update ON roles;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON roles;

-- RLS is already enabled by migration 0008's auto-loop; ensure FORCE
-- is also set so table owners don't bypass.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_role_isolation_select ON roles
  FOR SELECT USING (
    public.breeze_has_partner_access(partner_id)
    OR public.breeze_has_org_access(org_id)
    OR (is_system = true AND partner_id IS NULL AND org_id IS NULL
        AND public.breeze_current_scope() IS NOT NULL
        AND public.breeze_current_scope() <> 'none')
  );
CREATE POLICY breeze_role_isolation_insert ON roles
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    OR public.breeze_has_org_access(org_id)
  );
CREATE POLICY breeze_role_isolation_update ON roles
  FOR UPDATE USING (
    public.breeze_has_partner_access(partner_id)
    OR public.breeze_has_org_access(org_id)
  )
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    OR public.breeze_has_org_access(org_id)
  );
CREATE POLICY breeze_role_isolation_delete ON roles
  FOR DELETE USING (
    public.breeze_has_partner_access(partner_id)
    OR public.breeze_has_org_access(org_id)
  );

COMMIT;
