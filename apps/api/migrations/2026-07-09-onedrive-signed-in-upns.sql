-- Phase 4: agents report the UPNs of signed-in OneDrive users so delivery can
-- tag graph_group libraries per user. Additive, idempotent.
ALTER TABLE onedrive_device_state
  ADD COLUMN IF NOT EXISTS signed_in_upns JSONB NOT NULL DEFAULT '[]'::jsonb;
