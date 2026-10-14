-- A reset remains supported even when lifetime verification is unavailable.
-- Heartbeats rewrite this independent claim; missing/unknown versions become 0.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS pam_reconciliation_reset_protocol_version integer NOT NULL DEFAULT 0;
