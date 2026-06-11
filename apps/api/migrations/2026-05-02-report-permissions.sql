DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'reports' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('reports', 'read', 'View reports and report data');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'reports' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('reports', 'write', 'Create, update, and generate reports');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'reports' AND action = 'delete') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('reports', 'delete', 'Delete reports');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'reports' AND action = 'export') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('reports', 'export', 'Export report output');
  END IF;
END $$;

DO $$
DECLARE
  role_name text;
  perm_key text;
  v_permission_id uuid;
  v_role_id uuid;
  role_permissions_map jsonb := '{
    "Partner Technician": ["reports:read", "reports:write"],
    "Partner Viewer": ["reports:read"],
    "Org Admin": ["reports:read", "reports:write", "reports:delete", "reports:export"],
    "Org Technician": ["reports:read", "reports:write"],
    "Org Viewer": ["reports:read"]
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
