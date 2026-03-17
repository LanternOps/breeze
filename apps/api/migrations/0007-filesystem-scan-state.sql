CREATE TABLE IF NOT EXISTS device_filesystem_scan_state (
  device_id UUID PRIMARY KEY REFERENCES devices(id),
  last_run_mode TEXT NOT NULL DEFAULT 'baseline',
  last_baseline_completed_at TIMESTAMP,
  last_disk_used_percent REAL,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  aggregate JSONB NOT NULL DEFAULT '{}'::jsonb,
  hot_directories JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
