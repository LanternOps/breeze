-- Fail-closed follow-up to 2026-10-15-150030/150031: those migrations added
-- workspace:* and connected_apps:* permission rows but granted them to no
-- built-in role except Partner Admin (via its *:* wildcard). Every existing
-- Org Admin — full access within its organization — therefore lost Workspace
-- and partner connected-app access on upgrade the moment those permissions
-- started being enforced. Org Admin gets every new key by default; Org
-- Technician, viewers, and custom roles are deliberately left ungranted.
--
-- New installs get this from db/seed.ts SYSTEM_ROLES, but seed() only runs
-- when the users table is empty (apps/api/src/db/autoMigrate.ts) — an
-- existing install never re-seeds, so this migration is what carries the
-- grant to it.
--
-- Org Admin is a per-partner is_system role (one row per partner), so this
-- must sweep ALL of them. Matched on name + scope + is_system = TRUE only —
-- deliberately NO `partner_id IS NULL` clause, matching
-- 2026-10-08-100600-audit-retention-manage-permission.sql: is_system = TRUE
-- is what excludes attacker/operator-created custom roles named 'Org Admin'
-- (routes/roles.ts POST creates those with is_system = false); partner_id
-- plays no role in that boundary and every per-partner clone must be swept.
--
-- role_permissions has a composite PRIMARY KEY on (role_id, permission_id)
-- (apps/api/src/db/schema/users.ts), so ON CONFLICT DO NOTHING is a real
-- idempotency mechanism here — unlike `permissions`, which carries no
-- unique(resource, action) constraint.

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND p.resource IN ('workspace', 'connected_apps')
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'granted % workspace/connected_apps permission row(s) to existing Org Admin role(s)', n;
  END IF;
END $$;
