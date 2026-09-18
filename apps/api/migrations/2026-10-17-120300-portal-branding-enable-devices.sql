ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_devices boolean NOT NULL DEFAULT false;
