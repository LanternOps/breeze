-- Add data_source column to device_warranty to track where warranty data came from
-- Values: 'provider' (Dell/HP/Lenovo API), 'agent_plist' (macOS local plist), etc.
ALTER TABLE device_warranty
  ADD COLUMN IF NOT EXISTS data_source VARCHAR(50) DEFAULT 'provider';
