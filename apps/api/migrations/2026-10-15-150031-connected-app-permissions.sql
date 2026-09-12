-- Partner-global OAuth/MCP connected applications need capabilities distinct
-- from generic organization or device administration. Partner Admin
-- roles already satisfy these through *:*; custom roles receive no implicit
-- escalation and must be granted the new capabilities deliberately.
--
-- The permissions table has no unique(resource, action), so each catalog row
-- is guarded explicitly. This migration changes no tenant data.

SELECT set_config('breeze.scope', 'system', true);

INSERT INTO permissions (resource, action, description)
SELECT 'connected_apps', 'read', 'View partner connected OAuth applications'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions
  WHERE resource = 'connected_apps' AND action = 'read'
);

INSERT INTO permissions (resource, action, description)
SELECT 'connected_apps', 'manage', 'Disconnect partner connected OAuth applications'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions
  WHERE resource = 'connected_apps' AND action = 'manage'
);
