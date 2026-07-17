-- Backup job live-progress columns (stall detection + UI progress/speed).
-- last_progress_at: set on every backup_progress WS message and on the async
-- started-ack; NULL means the agent never reported progress (legacy agent).
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS last_progress_at timestamptz;
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS total_files integer;
