-- Register the separately authorized agent rollback capability. The mutable
-- directive and append-only event tables are completed by Track D Task 9.
INSERT INTO permissions (resource, action, description)
SELECT 'agent_rollback', 'create', 'Authorize a signed agent rollback'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'agent_rollback' AND action = 'create'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.resource = 'agent_rollback' AND p.action = 'create'
WHERE r.partner_id IS NULL
  AND r.scope = 'organization'
  AND r.name = 'Org Admin'
  AND r.is_system = TRUE
ON CONFLICT (role_id, permission_id) DO NOTHING;
