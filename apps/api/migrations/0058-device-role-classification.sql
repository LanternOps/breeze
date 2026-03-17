-- Device Role Classification: Add deviceRole and deviceRoleSource to devices,
-- roleFilter and osFilter to config_policy_assignments.

-- DDL: Add columns
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_role VARCHAR(30) NOT NULL DEFAULT 'unknown';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_role_source VARCHAR(20) NOT NULL DEFAULT 'auto';
ALTER TABLE config_policy_assignments ADD COLUMN IF NOT EXISTS role_filter VARCHAR(30)[];
ALTER TABLE config_policy_assignments ADD COLUMN IF NOT EXISTS os_filter VARCHAR(10)[];

-- Phase 1: Classify Windows Server editions
UPDATE devices d
SET device_role = 'server', device_role_source = 'auto'
WHERE d.device_role = 'unknown'
  AND d.os_version ILIKE '%server%';

-- Phase 2: Classify by known server model names
UPDATE devices d
SET device_role = 'server', device_role_source = 'auto'
FROM device_hardware dh
WHERE d.id = dh.device_id
  AND d.device_role = 'unknown'
  AND (dh.model ILIKE '%poweredge%' OR dh.model ILIKE '%proliant%'
       OR dh.model ILIKE '%system x%' OR dh.model ILIKE '%primergy%');

-- Phase 3: Default remaining to workstation
UPDATE devices
SET device_role = 'workstation', device_role_source = 'auto'
WHERE device_role = 'unknown';

-- Phase 4: Sync from linked discovered assets
UPDATE devices d
SET device_role = da.asset_type, device_role_source = 'discovery', updated_at = NOW()
FROM discovered_assets da
WHERE da.linked_device_id = d.id
  AND da.asset_type != 'unknown'
  AND d.device_role_source = 'auto';

-- Index for efficient role-based queries
CREATE INDEX IF NOT EXISTS devices_device_role_idx ON devices (device_role);
