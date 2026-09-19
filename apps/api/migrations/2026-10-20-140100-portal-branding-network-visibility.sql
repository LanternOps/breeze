ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_network_visibility boolean NOT NULL DEFAULT false;
