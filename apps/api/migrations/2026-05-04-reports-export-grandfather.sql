-- Grandfather reports:export onto any existing role that already has reports:read
-- or reports:write. The previous migration (2026-05-02-report-permissions.sql)
-- only granted reports:export to the seed "Org Admin" role; custom partner/org
-- roles created by tenants were missed and would 403 on routes that newly
-- require reports:export. This migration ensures backward-compatible access
-- for any role that previously could view or generate reports.

DO $$
DECLARE
  v_export_id uuid;
BEGIN
  SELECT id INTO v_export_id
  FROM permissions
  WHERE resource = 'reports' AND action = 'export'
  LIMIT 1;

  IF v_export_id IS NULL THEN
    RAISE NOTICE 'reports:export permission not present; skipping grandfather grant';
    RETURN;
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_export_id
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE p.resource = 'reports'
    AND p.action IN ('read', 'write')
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp2
      WHERE rp2.role_id = rp.role_id
        AND rp2.permission_id = v_export_id
    );
END $$;
