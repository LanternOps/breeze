DO $$ BEGIN
  CREATE TYPE filesystem_snapshot_trigger AS ENUM ('on_demand', 'threshold');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE filesystem_cleanup_run_status AS ENUM ('previewed', 'executed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS device_filesystem_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id),
  captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
  trigger filesystem_snapshot_trigger NOT NULL DEFAULT 'on_demand',
  partial BOOLEAN NOT NULL DEFAULT FALSE,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  largest_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  largest_dirs JSONB NOT NULL DEFAULT '[]'::jsonb,
  temp_accumulation JSONB NOT NULL DEFAULT '[]'::jsonb,
  old_downloads JSONB NOT NULL DEFAULT '[]'::jsonb,
  unrotated_logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  trash_usage JSONB NOT NULL DEFAULT '[]'::jsonb,
  duplicate_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  cleanup_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_filesystem_snapshots_device_captured
  ON device_filesystem_snapshots (device_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS device_filesystem_cleanup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id),
  requested_by UUID REFERENCES users(id),
  requested_at TIMESTAMP NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMP,
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  executed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  bytes_reclaimed BIGINT NOT NULL DEFAULT 0,
  status filesystem_cleanup_run_status NOT NULL DEFAULT 'previewed',
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_filesystem_cleanup_runs_device_requested
  ON device_filesystem_cleanup_runs (device_id, requested_at DESC);
