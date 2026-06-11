DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'billing' AND action = 'manage') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('billing', 'manage', 'Manage partner billing and billing portal access');
  END IF;
END $$;
