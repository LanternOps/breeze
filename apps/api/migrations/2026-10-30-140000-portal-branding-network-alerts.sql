-- Customer Portal Network Visibility (#5861 PR 3): independent, fail-closed
-- flag gating asset-level alert/ticket enrichment (activeAlertCount,
-- highestAlertSeverity, openTicketCount) on GET /portal/network/assets.
-- Deliberately NOT part of PORTAL_VISIBILITY_FLAG_KEYS / "Enable all" --
-- same reasoning as the parent enable_network_visibility flag: alert data is
-- a distinct sensitivity tier from asset inventory, gated separately.
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_network_alerts boolean NOT NULL DEFAULT false;
