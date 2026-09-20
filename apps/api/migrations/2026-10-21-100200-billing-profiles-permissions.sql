-- billing_profiles:read / billing_profiles:write (spec 2026-09-17 §6). W01, #4615.
--
-- seed.ts's DEFAULT_PERMISSIONS + seedRoles reconcile the SYSTEM roles on a
-- fresh database. They do NOT reach per-partner role clones or custom roles on
-- an already-deployed instance, so every prior permission addition shipped a
-- migration like this one (2026-10-16-190000-agreements-permission.sql,
-- 2026-10-15-150200-pam-dedicated-permissions.sql).
--
-- WRITES ROWS: breeze.scope is elected to 'system' FIRST. Without it the INSERT
-- aborts with 42501 under FORCE ROW LEVEL SECURITY (CLAUDE.md; enforced by
-- apps/api/src/db/migrationRlsScope.test.ts, whose frozen baseline this file
-- must NEVER join). is_local = true scopes it to autoMigrate's per-file txn.
--
-- Back-fill target: only roles that already hold '*:*' get the new grants
-- implicitly (permissionGrantMatches wildcards at match time, so no row is
-- needed for them). Roles holding tickets:write are the ones that configure
-- partner-wide ticketing today, so they receive billing_profiles:read --
-- READ ONLY. Write is deliberately NOT back-filled: it is a new capability and
-- an operator grants it in the role editor. Over-granting on upgrade is
-- invisible to the operator; under-granting is one click.
--
-- Idempotent; no inner BEGIN/COMMIT.

SELECT set_config('breeze.scope', 'system', true);

-- `permissions` has NO unique constraint on (resource, action) — only the PK on id —
-- so `ON CONFLICT (resource, action)` fails with 42P10 on the FIRST apply. Use the
-- IF NOT EXISTS idiom every precedent uses (2026-10-16-190000-agreements-permission.sql:81-101).
DO $$
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'billing_profiles' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('billing_profiles', 'read', 'View work types and billing profiles (rate cards)');
    RAISE WARNING 'seeded billing_profiles:read permission row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'billing_profiles' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('billing_profiles', 'write', 'Create and manage work types and billing profiles');
    RAISE WARNING 'seeded billing_profiles:write permission row';
  END IF;
END $$;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, newp.id
    FROM role_permissions rp
    JOIN permissions existing ON existing.id = rp.permission_id
    CROSS JOIN permissions newp
   WHERE existing.resource = 'tickets' AND existing.action = 'write'
     AND newp.resource = 'billing_profiles' AND newp.action = 'read'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'granted billing_profiles:read to % roles holding tickets:write', n;
END $$;
