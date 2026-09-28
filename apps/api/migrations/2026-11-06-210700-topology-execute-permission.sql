-- topology:execute permission (#5995 W04). requireTopologySiteAccess('execute')
-- (services/topology/access.ts) has required topology:execute since M1, but no
-- migration created the permission, so no role could grant it: topology
-- diagnostics, traceroute, policy arming and AI-proposed diagnostics were
-- reachable only by wildcard roles. Granted to Org Admin, Org Technician (who
-- already hold devices:execute) and Partner Admin; others by explicit role edit.
-- Idempotent (existence-guarded); no inner transaction.
DO $$
DECLARE
  v_permission_id uuid;
  v_role record;
  granted int := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT id INTO v_permission_id FROM permissions WHERE resource = 'topology' AND action = 'execute' LIMIT 1;
  IF v_permission_id IS NULL THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('topology', 'execute', 'Run topology diagnostics and arm scheduled topology checks')
    RETURNING id INTO v_permission_id;
  END IF;

  FOR v_role IN SELECT id FROM roles WHERE name IN ('Partner Admin', 'Org Admin', 'Org Technician') LOOP
    IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = v_role.id AND permission_id = v_permission_id) THEN
      INSERT INTO role_permissions (role_id, permission_id) VALUES (v_role.id, v_permission_id);
      granted := granted + 1;
    END IF;
  END LOOP;
  IF granted > 0 THEN
    RAISE WARNING 'granted topology:execute to % role(s)', granted;
  END IF;
END $$;
