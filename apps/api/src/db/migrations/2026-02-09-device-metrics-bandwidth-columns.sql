ALTER TABLE device_metrics
  ADD COLUMN IF NOT EXISTS bandwidth_in_bps BIGINT,
  ADD COLUMN IF NOT EXISTS bandwidth_out_bps BIGINT,
  ADD COLUMN IF NOT EXISTS interface_stats JSONB;
