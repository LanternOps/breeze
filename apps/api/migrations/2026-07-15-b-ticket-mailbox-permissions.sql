INSERT INTO permissions (resource, action, description)
VALUES
  ('ticket_mailbox', 'read', 'View Microsoft 365 ticket mailbox connection status'),
  ('ticket_mailbox', 'admin', 'Connect, verify, retest, and disable Microsoft 365 ticket mailboxes')
ON CONFLICT (resource, action) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.resource = 'ticket_mailbox'
 AND p.action = 'read'
WHERE r.is_system = true
  AND r.scope = 'partner'
  AND r.name IN ('Partner Admin', 'Partner Technician', 'Partner Viewer')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.resource = 'ticket_mailbox'
 AND p.action = 'admin'
WHERE r.is_system = true
  AND r.scope = 'partner'
  AND r.name = 'Partner Admin'
ON CONFLICT DO NOTHING;
