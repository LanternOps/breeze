-- Add TCC (Transparency, Consent, Control) permissions column for macOS devices
ALTER TABLE devices ADD COLUMN IF NOT EXISTS tcc_permissions JSONB;
