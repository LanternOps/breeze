-- Maintenance window: reboot devices with a pending reboot while the window is active.
-- Additive boolean on the existing maintenance-settings table (config policy Pattern B).
ALTER TABLE config_policy_maintenance_settings
  ADD COLUMN IF NOT EXISTS reboot_if_pending boolean NOT NULL DEFAULT false;
