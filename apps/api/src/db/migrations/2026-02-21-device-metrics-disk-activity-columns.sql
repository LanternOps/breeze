ALTER TABLE device_metrics
  ADD COLUMN IF NOT EXISTS disk_activity_available BOOLEAN,
  ADD COLUMN IF NOT EXISTS disk_read_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS disk_write_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS disk_read_bps BIGINT,
  ADD COLUMN IF NOT EXISTS disk_write_bps BIGINT,
  ADD COLUMN IF NOT EXISTS disk_read_ops BIGINT,
  ADD COLUMN IF NOT EXISTS disk_write_ops BIGINT;
