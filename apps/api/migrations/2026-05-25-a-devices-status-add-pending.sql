-- Add 'pending' to device_status enum so admin-provisioned devices (devices
-- pre-created via POST /api/v1/devices/provision before the agent ever runs)
-- can be distinguished from offline-because-agent-stopped.
--
-- Without this, provisioned-but-not-yet-installed devices land in 'offline',
-- which:
--   - inflates the dashboard "X offline" badge (DeviceStatusChart.tsx)
--   - silently lowers MSP compliance scores: (online+maintenance)/total in
--     reports/data.ts:369,414 and analytics.ts:1263, metrics.ts:609
--   - injects "Device offline" into generated report wording
--
-- offlineDetector (jobs/offlineDetector.ts:120) scans only
-- status IN ('online','updating') for offline-flip transitions, so adding
-- 'pending' does NOT introduce false offline-alert noise on pre-provisioned
-- rows.
--
-- Postgres note: ALTER TYPE ... ADD VALUE inside an outer transaction works
-- in Postgres 12+ as long as the new value isn't *used* in the same
-- transaction. autoMigrate wraps each file in client.begin(); we never use
-- 'pending' in this migration, so no rewrite occurs.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'device_status') THEN
    ALTER TYPE device_status ADD VALUE IF NOT EXISTS 'pending';
  END IF;
END $$;
