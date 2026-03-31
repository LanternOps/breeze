ALTER TABLE devices
ADD COLUMN IF NOT EXISTS desktop_access jsonb;
