-- webhooks:read: a dedicated permission for reading webhook configuration and
-- delivery history (GET /webhooks, GET /webhooks/:id, GET /webhooks/:id/deliveries
-- and the query_webhooks AI tool). These reads previously required
-- organizations:read. Managing webhooks is unchanged (organizations:write).
--
-- Built-in roles: Org Admin, Org Technician and Partner Technician receive it,
-- matching DEFAULT_PERMISSIONS / SYSTEM_ROLES in apps/api/src/db/seed.ts.
-- Grant predicate copies 2026-10-23-110000-ai-sessions-use-permission.sql:
-- match name + scope + `is_system = TRUE`, with NO `partner_id IS NULL`
-- clause, because built-in roles are cloned per partner. `is_system = TRUE`
-- keeps a custom role that happens to be named "Org Admin" out of this grant.
-- Partner Admin holds '*:*' and needs no row. Viewer, billing and
-- security-approver roles do not receive it.
--
-- Custom roles (is_system = FALSE): a role that can manage webhooks
-- (organizations:write, or the organizations:* wildcard) receives
-- webhooks:read so it keeps seeing what it manages. A custom role holding only
-- organizations:read is NOT granted it; an administrator adds it explicitly.
--
-- permissions has NO UNIQUE(resource, action), so the catalog insert uses an
-- explicit existence check; role_permissions is PRIMARY KEY (role_id,
-- permission_id), so the grants use ON CONFLICT DO NOTHING. Idempotent.
--
-- roles / role_permissions / permissions are FORCE RLS: elect system scope
-- first or the writes below match zero rows silently (migrationRlsScope.test).
SELECT set_config('breeze.scope', 'system', true);

-- The description MUST stay byte-identical to DEFAULT_PERMISSIONS.
INSERT INTO permissions (resource, action, description)
SELECT 'webhooks', 'read', 'View webhook configuration and delivery history'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'webhooks' AND action = 'read'
);

DO $$
DECLARE
  n integer;
  v_perm uuid;
BEGIN
  SELECT id INTO v_perm FROM permissions
  WHERE resource = 'webhooks' AND action = 'read' ORDER BY id LIMIT 1;

  IF v_perm IS NULL THEN
    RAISE WARNING 'webhooks-read-permission: webhooks:read row missing; no grants made';
    RETURN;
  END IF;

  -- Built-in roles.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_perm
  FROM roles r
  WHERE r.is_system = TRUE
    AND (
      (r.scope = 'organization' AND r.name IN ('Org Admin', 'Org Technician'))
      OR (r.scope = 'partner' AND r.name = 'Partner Technician')
    )
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'webhooks-read-permission: granted webhooks:read to % built-in role(s)', n;

  -- Custom roles that already manage webhooks.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT r.id, v_perm
  FROM roles r
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE r.is_system = FALSE
    AND p.resource = 'organizations'
    AND p.action IN ('write', '*')
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'webhooks-read-permission: granted webhooks:read to % custom role(s) holding organizations:write', n;
END $$;
