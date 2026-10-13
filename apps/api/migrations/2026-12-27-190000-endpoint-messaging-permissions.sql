-- #8741 (endpoint messaging W1): `endpoint_messages:send` and
-- `endpoint_messages:read` permissions. `send` pushes a technician-authored
-- message onto an end user's desktop; `read` is the history/receipt read used
-- by later waves. Granted to the system roles that hold `devices:execute`
-- today: Partner Technician, Org Technician and Org Admin. Partner Admin holds
-- '*:*' and needs no row. Org Viewer (and any other read-only role) gets nothing.
--
-- Grant predicate copies 2026-12-20-220100-sites-set-location-permission.sql:
-- match `r.name`, `r.scope` and `r.is_system = TRUE` with NO
-- `partner_id IS NULL` clause (per-partner `is_system` clones exist in
-- production); `is_system = TRUE` is the anti-forgery filter, so a custom
-- role merely named "Org Admin" gets nothing. Idempotent.
--
-- permissions has NO UNIQUE(resource, action), so the catalog insert uses an
-- explicit existence check; role_permissions does, so the grant uses
-- ON CONFLICT DO NOTHING.
--
-- roles / role_permissions / permissions are FORCE RLS: elect system scope
-- first or the writes below match zero rows silently (migrationRlsScope.test).
SELECT set_config('breeze.scope', 'system', true);

INSERT INTO permissions (resource, action, description)
SELECT 'endpoint_messages', 'send', 'Send messages to end users'' desktops'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'endpoint_messages' AND action = 'send'
);

INSERT INTO permissions (resource, action, description)
SELECT 'endpoint_messages', 'read', 'View sent endpoint messages and delivery receipts'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'endpoint_messages' AND action = 'read'
);

DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN (
    SELECT id FROM permissions
    WHERE resource = 'endpoint_messages' AND action IN ('send', 'read')
  ) p
  WHERE r.is_system = TRUE
    AND (
      (r.scope = 'organization' AND r.name IN ('Org Admin', 'Org Technician'))
      OR (r.scope = 'partner' AND r.name = 'Partner Technician')
    )
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'endpoint-messaging-permissions: granted endpoint_messages:send/read to Org Admin / Org Technician / Partner Technician (% row(s))', n;
END $$;
