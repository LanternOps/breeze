-- #6396: give own-session AI chat its own capability instead of gating it on
-- organizations:write / organizations:read.
--
-- POST /ai/sessions and the other own-session lifecycle routes required
-- organizations:write, and the own-session reads organizations:read. No seeded
-- organization-scope role holds EITHER, so an org user could be granted every
-- AI permission we ship (ai_agents:*, ai_sessions:read_all, approvals:decide)
-- and still get 403 on the first chat request. Partner Technician holds
-- organizations:read only, so it could list sessions but never open one. Tool
-- calls inside a session are authorized per tool at route parity (#6110), so
-- opening the conversation does not widen what a role can do.
--
-- Grant predicate copies 2026-10-15-150200-pam-dedicated-permissions.sql:
-- match `r.name`, `r.scope` and `r.is_system = TRUE` with NO
-- `partner_id IS NULL` clause — per-partner `is_system` role clones exist in
-- production, and a global-template-only grant would reach nobody on upgrade.
-- `is_system = TRUE` is the anti-forgery filter: custom roles are always
-- is_system = FALSE, so a custom role merely named "Org Admin" gets nothing.
-- Partner Admin holds '*:*' and needs no row. Idempotent.
--
-- permissions has NO UNIQUE(resource, action), so the catalog insert uses an
-- explicit existence check; role_permissions does, so the grant uses
-- ON CONFLICT DO NOTHING.
--
-- roles / role_permissions / permissions are FORCE RLS: elect system scope
-- first or the writes below match zero rows silently (migrationRlsScope.test).
SELECT set_config('breeze.scope', 'system', true);

INSERT INTO permissions (resource, action, description)
SELECT 'ai_sessions', 'use', 'Open and drive your own AI chat sessions'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ai_sessions' AND action = 'use'
);

DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN (
    SELECT id FROM permissions WHERE resource = 'ai_sessions' AND action = 'use'
  ) p
  WHERE r.is_system = TRUE
    AND (
      (r.scope = 'organization' AND r.name IN ('Org Admin', 'Org Technician'))
      OR (r.scope = 'partner' AND r.name = 'Partner Technician')
    )
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai-sessions-use-permission: granted ai_sessions:use to Org Admin / Org Technician / Partner Technician (% row(s))', n;
END $$;
