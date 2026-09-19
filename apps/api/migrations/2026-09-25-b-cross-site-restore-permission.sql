-- Seed the distinct cross-site restore capability and grant it to existing
-- system Org Admin roles. Ordinary backup:write remains site-scoped.
-- Sequenced after the already-shipped 2026-09-24-b migration set.
--
-- Partner Admin already holds the wildcard '*:*' permission, so no redundant
-- literal grant is needed. Org Admin roles are seeded per-partner, so this
-- migration must grant every built-in Org Admin row.
--
-- Idempotent: permissions has no unique constraint on (resource, action), so
-- use an explicit existence check rather than ON CONFLICT DO NOTHING.

DO $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions
    WHERE resource = 'backup' AND action = 'cross_site_restore'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('backup', 'cross_site_restore', 'Restore backup data across sites');
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;

  IF n > 0 THEN
    RAISE WARNING 'seeded % backup:cross_site_restore permission row(s)', n;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  v_permission_id uuid;
BEGIN
  -- Resolve one permission id deterministically even if legacy data contains
  -- duplicate resource/action rows.
  SELECT id INTO v_permission_id
  FROM permissions
  WHERE resource = 'backup' AND action = 'cross_site_restore'
  ORDER BY id
  LIMIT 1;

  -- is_system = TRUE prevents a custom role named "Org Admin" from receiving
  -- a security-sensitive recovery capability.
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
    RAISE WARNING 'granted backup:cross_site_restore to % existing Org Admin role(s)', n;
  END IF;
END $$;
