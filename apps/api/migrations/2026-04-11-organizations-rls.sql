-- 2026-04-11: Enable RLS on the organizations table.
--
-- `organizations` was missed by migration 0008's auto-enable DO loop because
-- it has no `org_id` column — its own `id` IS the tenant identifier. This
-- migration installs the standard four breeze_org_isolation_* policies but
-- keyed on `id` instead of `org_id`, so every SELECT/UPDATE/DELETE of a
-- concrete row is gated by public.breeze_has_org_access(id).
--
-- Note on INSERT + RETURNING: a freshly created org's id cannot be in any
-- caller's accessible_org_ids pre-insert. Both tenant-creation call sites
-- (apps/api/src/routes/auth/register.ts and apps/api/src/routes/orgs.ts
-- POST /organizations) have been updated to run the insert under system
-- scope, which makes public.breeze_has_org_access() short-circuit to true
-- and lets the INSERT and the RETURNING SELECT pass.
--
-- Fully idempotent — safe to re-run.

BEGIN;

-- ============================================================
-- organizations
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON organizations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON organizations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON organizations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON organizations;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON organizations
  FOR SELECT USING (public.breeze_has_org_access(id));
CREATE POLICY breeze_org_isolation_insert ON organizations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(id));
CREATE POLICY breeze_org_isolation_update ON organizations
  FOR UPDATE USING (public.breeze_has_org_access(id))
  WITH CHECK (public.breeze_has_org_access(id));
CREATE POLICY breeze_org_isolation_delete ON organizations
  FOR DELETE USING (public.breeze_has_org_access(id));

COMMIT;
