-- Watchdog status enum
DO $$ BEGIN
    CREATE TYPE watchdog_status AS ENUM ('connected', 'failover', 'offline');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add watchdog columns to devices
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_status watchdog_status;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_last_seen timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_version varchar(50);

-- Add target_role to device_commands (defaults to 'agent' for backward compat)
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS target_role varchar(20) NOT NULL DEFAULT 'agent';

-- Index for command polling filtered by role
CREATE INDEX IF NOT EXISTS idx_device_commands_target_role ON device_commands (device_id, target_role, status) WHERE status = 'pending';
