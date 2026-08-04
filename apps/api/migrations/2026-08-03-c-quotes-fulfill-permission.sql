-- quotes:fulfill — mark accepted-quote lines ordered/received. Deliberately NOT
-- quotes:write (documented as draft editing) so read-only viewers and
-- draft-editors don't inherit procurement mutation rights.
INSERT INTO permissions (resource, action, description)
SELECT 'quotes', 'fulfill', 'Record procurement orders and receipts against accepted quotes'
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'quotes' AND action = 'fulfill');

-- Grant to every system role that already holds quotes:write.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT rp.role_id, p_new.id
  FROM role_permissions rp
  JOIN permissions p_write ON p_write.id = rp.permission_id
    AND p_write.resource = 'quotes' AND p_write.action = 'write'
  JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE
  CROSS JOIN (SELECT id FROM permissions WHERE resource='quotes' AND action='fulfill' LIMIT 1) p_new
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'quotes-fulfill: granted to % system role(s)', n;
END $$;
