-- Block hours W04 (#8179): independent, fail-closed flag for the read-only
-- "Support hours" card the customer portal shows inside its Support usage
-- section (prepaid block hours used / remaining).
-- Deliberately NOT part of PORTAL_VISIBILITY_FLAG_KEYS / "Enable all
-- visibility": the card exposes a prepaid-hours balance, a billing figure the
-- MSP must choose to show -- same reasoning as enable_network_alerts.
-- No row is written, so no breeze.scope preamble is needed.
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_hour_block boolean NOT NULL DEFAULT false;
