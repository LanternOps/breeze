-- devices:recover_agent (#9234 step 1): ask the watchdog to restart or start a
-- wedged/stopped agent from the device page (POST /devices/:id/agent-recovery).
-- Its own permission so an MSP can grant agent recovery without arbitrary
-- device commands, or withhold it from a role that holds devices:execute.
--
-- Back-filled to every SYSTEM role that already holds devices:execute (Org
-- Admin, Org Technician, Partner Technician; Partner Admin matches via *:*).
-- That grants no new authority: devices:execute already reaches the same
-- watchdog restart through the trigger_agent_restart AI tool. Custom roles are
-- left to an operator, like quotes:fulfill (2026-08-03-c).
-- Idempotent (existence-guarded insert, ON CONFLICT grant); no inner transaction.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  v_permission_id uuid;
  granted integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT id INTO v_permission_id FROM permissions
  WHERE resource = 'devices' AND action = 'recover_agent' LIMIT 1;
  IF v_permission_id IS NULL THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('devices', 'recover_agent', 'Restart or start the agent through the watchdog')
    RETURNING id INTO v_permission_id;
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_permission_id
  FROM role_permissions rp
  JOIN permissions p_exec ON p_exec.id = rp.permission_id
    AND p_exec.resource = 'devices' AND p_exec.action = 'execute'
  JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS granted = ROW_COUNT;
  IF granted > 0 THEN
    RAISE WARNING 'devices-recover-agent: granted to % system role(s)', granted;
  END IF;
END $$;
