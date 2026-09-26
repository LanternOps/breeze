-- Alerting consolidation W05e — network checks become monitors.
-- Converted checks are adopted in place; explicitly retired checks and legacy
-- alert rules are retained for history and reversal. No DML in this file.

ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS retired_reason text;

ALTER TABLE network_monitor_alert_rules ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE network_monitor_alert_rules ADD COLUMN IF NOT EXISTS retired_reason text;

-- Pending conversion reads unmanaged, unretired rows per organization.
CREATE INDEX IF NOT EXISTS network_monitors_unmanaged_pending_idx
  ON network_monitors (org_id)
  WHERE managed_by_monitor_id IS NULL AND retired_at IS NULL;

-- Reuse discovered_assets_id_org_id_uniq from the manual-assets migration.
-- Keep the existing asset/site FK and ownership trigger as additional guards.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'network_monitors'::regclass AND conname = 'network_monitors_asset_org_fk') THEN
    ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_asset_org_fk
      FOREIGN KEY (asset_id, org_id) REFERENCES discovered_assets (id, org_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'network_monitors'::regclass AND conname = 'network_monitors_asset_org_required') THEN
    ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_asset_org_required
      CHECK (asset_id IS NULL OR (org_id IS NOT NULL AND partner_id IS NULL));
  END IF;
END $$;

ALTER TABLE monitor_conversions ADD COLUMN IF NOT EXISTS network_source_snapshot jsonb;
