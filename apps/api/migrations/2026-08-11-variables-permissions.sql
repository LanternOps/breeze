-- Seed the variables:read / variables:manage permissions and grant them to
-- existing system Org Admin roles (#3409 PR 1).
--
-- Without this, already-deployed orgs have the tenant variables settings page
-- gated behind a permission no role holds: the nav entry never renders and
-- every CRUD call 403s, including for the Org Admin who is supposed to manage
-- them. New installs get the rows from DEFAULT_PERMISSIONS in db/seed.ts; this
-- migration covers the ones already in the field.
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
-- Use an explicit existence check, matching 2026-07-18-b-approvals-decide-seed.sql.

DO $$
DECLARE
  n integer := 0;
  total integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'variables' AND action = 'read'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('variables', 'read', 'View tenant variable definitions');
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'variables' AND action = 'manage'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('variables', 'manage', 'Create, edit, and delete tenant variables');
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END IF;

  IF total > 0 THEN
    RAISE WARNING 'seeded % variables:* permission row(s)', total;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  total integer := 0;
  v_action text;
  v_permission_id uuid;
BEGIN
  FOREACH v_action IN ARRAY ARRAY['read', 'manage'] LOOP
    -- Scalar lookup (not a JOIN) so this stays correct even if a duplicate
    -- permissions row were ever present — always resolves to exactly one id.
    SELECT id INTO v_permission_id
    FROM permissions
    WHERE resource = 'variables' AND action = v_action
    ORDER BY id
    LIMIT 1;

    -- is_system = TRUE is LOAD-BEARING, not cosmetic: custom org roles accept
    -- an arbitrary caller-supplied name (routes/roles.ts POST creates them
    -- with is_system = false), so matching on name alone would grant this to
    -- any attacker-created role named 'Org Admin'. Only the built-in
    -- per-partner Org Admin roles carry is_system = TRUE. Mirrors
    -- 2026-07-18-b-approvals-decide-seed.sql.
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
    total := total + n;
  END LOOP;

  IF total > 0 THEN
    RAISE WARNING 'granted variables:* to % existing Org Admin role(s)', total;
  END IF;
END $$;
