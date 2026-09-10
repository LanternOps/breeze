-- Register explicit authorization boundaries for the built-in Workspace
-- extension. Tenant reachability alone never grants any of these operations.
--
-- Existing wildcard administrators retain access through *:*; all other roles
-- must receive an intentional assignment. This fail-closed rollout avoids
-- silently preserving the pre-migration behavior for read-only partner roles.
--
-- `permissions` has no unique(resource, action) constraint, so ON CONFLICT is
-- not an idempotency mechanism here. Resolve each row with an existence check.

DO $$
DECLARE
  n integer := 0;
  total integer := 0;
  v_action text;
  v_description text;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  FOR v_action, v_description IN VALUES
    ('read', 'View Workspace sources and processing status'),
    ('write', 'Configure Workspace sources and settings'),
    ('credentials', 'Manage Workspace source credentials'),
    ('execute', 'Run Workspace crawling and content processing')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM permissions
      WHERE resource = 'workspace' AND action = v_action
    ) THEN
      INSERT INTO permissions (resource, action, description)
      VALUES ('workspace', v_action, v_description);
      GET DIAGNOSTICS n = ROW_COUNT;
      total := total + n;
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE WARNING 'workspace-permissions: inserted % permission row(s)', total;
  END IF;
END $$;
