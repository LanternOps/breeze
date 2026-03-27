-- Add is_headless column to devices table.
-- Headless devices (no display) cannot support remote desktop connections.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'devices' AND column_name = 'is_headless') THEN
    ALTER TABLE devices ADD COLUMN is_headless boolean NOT NULL DEFAULT false;
  END IF;
END $$;
