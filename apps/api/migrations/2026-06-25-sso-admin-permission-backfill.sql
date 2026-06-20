-- Security review #2 (H-2): introduce sso:admin and backfill it to every role
-- that currently holds organizations:write, so no existing SSO admin loses the
-- ability to configure providers when the gate moved from orgs:write to
-- sso:admin. Wildcard ('*','*') roles satisfy sso:admin at check time, so they
-- need no row here. Idempotent.

-- 1. Ensure the sso:admin catalog row exists exactly once (permissions has no
--    unique(resource,action), so guard with WHERE NOT EXISTS).
INSERT INTO permissions (resource, action, description)
SELECT 'sso', 'admin', 'Manage SSO providers and verified domains'
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'sso' AND action = 'admin');

-- 2. Grant sso:admin to every role with an explicit organizations:write row.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, s.id
  FROM role_permissions rp
  JOIN permissions w ON w.id = rp.permission_id AND w.resource = 'organizations' AND w.action = 'write'
  CROSS JOIN (SELECT id FROM permissions WHERE resource = 'sso' AND action = 'admin' LIMIT 1) s
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'sso:admin backfill granted % role(s)', n;
END $$;
