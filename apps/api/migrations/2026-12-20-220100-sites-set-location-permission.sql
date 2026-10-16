-- #4186 W1 (Gate A Q2): narrow `sites:set_location` permission so a field
-- technician can pin a site's map location without holding `sites:write`.
-- Seeded technician roles hold `sites:read` only. OD-4: granted to Partner
-- Technician, Org Technician and Org Admin; Partner Admin holds '*:*' and
-- needs no row. Org Viewer gets nothing.
--
-- Grant predicate copies 2026-10-23-110000-ai-sessions-use-permission.sql:
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
SELECT 'sites', 'set_location', 'Pin a site''s map location from the field'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'sites' AND action = 'set_location'
);

DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN (
    SELECT id FROM permissions WHERE resource = 'sites' AND action = 'set_location'
  ) p
  WHERE r.is_system = TRUE
    AND (
      (r.scope = 'organization' AND r.name IN ('Org Admin', 'Org Technician'))
      OR (r.scope = 'partner' AND r.name = 'Partner Technician')
    )
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'sites-set-location-permission: granted sites:set_location to Org Admin / Org Technician / Partner Technician (% row(s))', n;
END $$;
