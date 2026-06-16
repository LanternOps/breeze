-- Per-partner AI for Office entitlement (operator-granted, off by default).
-- The partner table already has partner-axis RLS; a non-tenant-key column
-- inherits the existing row policies, so no policy change is needed.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS ai_for_office_enabled boolean NOT NULL DEFAULT false;
