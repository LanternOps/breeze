-- Seed the audit:manage permission and grant it to existing system Org Admin
-- roles (#4633).
--
-- Without this, already-deployed orgs have no way to create/edit an
-- audit_retention_policies row: the new settings route 403s for every role,
-- including Org Admin, because the permission row does not exist in the
-- field until this migration runs. New installs get the row (and the grant,
-- via SYSTEM_ROLES) from db/seed.ts, but seed() only runs when the users
-- table is empty (apps/api/src/db/autoMigrate.ts) — an existing install never
-- re-seeds, so this migration is what carries the change to it.
--
-- Partner Admin already holds the wildcard '*:*' permission, so it needs no
-- explicit row here. Org Admin roles are seeded per-partner (one row per
-- partner), so this must sweep ALL of them, not a single row.
--
-- Idempotent: safe to re-run. permissions.id defaults to gen_random_uuid() at
-- the DB level (0001-baseline.sql), so no id is supplied on insert.
--
-- NOTE: permissions has NO UNIQUE constraint on (resource, action) — only a
-- primary key on id. `ON CONFLICT DO NOTHING` therefore has nothing to
-- conflict against and would silently insert a duplicate on every re-apply.
-- Use an explicit existence check, matching
-- 2026-08-11-variables-permissions.sql / 2026-07-18-b-approvals-decide-seed.sql.

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'audit' AND action = 'manage'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('audit', 'manage', 'Manage the audit log retention policy');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded audit:manage permission row';
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  v_permission_id uuid;
BEGIN
  -- Scalar lookup (not a JOIN) so this stays correct even if a duplicate
  -- permissions row were ever present — always resolves to exactly one id.
  SELECT id INTO v_permission_id
  FROM permissions
  WHERE resource = 'audit' AND action = 'manage'
  ORDER BY id
  LIMIT 1;

  -- is_system = TRUE is LOAD-BEARING, not cosmetic: custom org roles accept an
  -- arbitrary caller-supplied name (routes/roles.ts POST creates them with
  -- is_system = false), so matching on name alone would grant this to any
  -- attacker-created role named 'Org Admin'. Only the built-in per-partner
  -- Org Admin roles carry is_system = TRUE.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_permission_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_permission_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_permission_id
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'granted audit:manage to % existing Org Admin role(s)', n;
  END IF;
END $$;
