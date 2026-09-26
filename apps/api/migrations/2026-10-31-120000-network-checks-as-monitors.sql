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
