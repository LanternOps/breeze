-- SR5-09: introduce ai_sessions:read_all and grant it to the global Org Admin
-- system role. This gates the cross-user AI session audit dashboard
-- (GET /admin/sessions) behind a dedicated capability instead of
-- organizations:read, which was too broad (any org-read holder could enumerate
-- every user's AI sessions). Partner Admin keeps access via its *:* grant.
--
-- Operates ONLY on the global Org Admin system role row (partner_id IS NULL,
-- is_system = TRUE). Per-partner cloned Partner Admin rows carry *:* and keep
-- everything; custom roles are untouched. Idempotent.

-- 1. Ensure the permission catalog row exists exactly once (permissions has no
--    unique(resource,action), so guard with WHERE NOT EXISTS).
INSERT INTO permissions (resource, action, description)
SELECT 'ai_sessions', 'read_all', 'View all users'' AI session history (admin audit dashboard)'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ai_sessions' AND action = 'read_all'
);

-- 2. Grant it to the global Org Admin system role.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN (SELECT id FROM permissions WHERE resource = 'ai_sessions' AND action = 'read_all' LIMIT 1) p
  WHERE r.partner_id IS NULL AND r.scope = 'organization'
    AND r.name = 'Org Admin' AND r.is_system = TRUE
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai-sessions-read-all: granted ai_sessions:read_all to % Org Admin role(s)', n;
END $$;
