UPDATE permissions
SET description = 'View Microsoft 365 ticket mailbox connection status'
WHERE resource = 'ticket_mailbox' AND action = 'read';

INSERT INTO permissions (resource, action, description)
SELECT 'ticket_mailbox', 'read', 'View Microsoft 365 ticket mailbox connection status'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ticket_mailbox' AND action = 'read'
);

UPDATE permissions
SET description = 'Connect, verify, retest, and disable Microsoft 365 ticket mailboxes'
WHERE resource = 'ticket_mailbox' AND action = 'admin';

INSERT INTO permissions (resource, action, description)
SELECT 'ticket_mailbox', 'admin', 'Connect, verify, retest, and disable Microsoft 365 ticket mailboxes'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ticket_mailbox' AND action = 'admin'
);

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
