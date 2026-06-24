-- topology:read / topology:write grants + role assignment (Phase 3, issue #1728).
-- Data-only migration (no schema change): inserts the two topology permissions and
-- assigns them to the relevant system roles. Idempotent (existence-guarded);
-- re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate wraps each file).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'topology' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('topology', 'read', 'View network topology and saved layout');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'topology' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('topology', 'write', 'Persist topology node layout (drag-to-save)');
  END IF;
END $$;

DO $$
DECLARE
  role_name text;
  perm_key text;
  v_permission_id uuid;
  v_role_id uuid;
  role_permissions_map jsonb := '{
    "Partner Admin": ["topology:read", "topology:write"],
    "Partner Technician": ["topology:read"],
    "Org Admin": ["topology:read", "topology:write"],
    "Org Technician": ["topology:read", "topology:write"],
    "Org Viewer": ["topology:read"]
  }'::jsonb;
BEGIN
  FOR role_name IN SELECT jsonb_object_keys(role_permissions_map)
  LOOP
    SELECT id INTO v_role_id FROM roles WHERE name = role_name LIMIT 1;
    IF v_role_id IS NULL THEN
      CONTINUE;
    END IF;

    FOR perm_key IN SELECT jsonb_array_elements_text(role_permissions_map -> role_name)
    LOOP
      SELECT id INTO v_permission_id
      FROM permissions
      WHERE resource = split_part(perm_key, ':', 1)
        AND action = split_part(perm_key, ':', 2)
      LIMIT 1;

      IF v_permission_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM role_permissions
          WHERE role_permissions.role_id = v_role_id
            AND role_permissions.permission_id = v_permission_id
        )
      THEN
        INSERT INTO role_permissions (role_id, permission_id)
        VALUES (v_role_id, v_permission_id);
      END IF;
    END LOOP;
  END LOOP;
END $$;
