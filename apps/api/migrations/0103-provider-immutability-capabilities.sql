ALTER TABLE backup_configs
  ADD COLUMN provider_capabilities jsonb,
  ADD COLUMN provider_capabilities_checked_at timestamp;

ALTER TABLE backup_snapshots
  ADD COLUMN requested_immutability_enforcement varchar(20),
  ADD COLUMN immutability_fallback_reason text;
