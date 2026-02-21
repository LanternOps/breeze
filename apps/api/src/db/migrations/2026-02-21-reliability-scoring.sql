DO $$
BEGIN
  CREATE TYPE trend_direction AS ENUM ('improving', 'stable', 'degrading');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS device_reliability_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  collected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  uptime_seconds BIGINT NOT NULL,
  boot_time TIMESTAMP NOT NULL,
  crash_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  app_hangs JSONB NOT NULL DEFAULT '[]'::jsonb,
  service_failures JSONB NOT NULL DEFAULT '[]'::jsonb,
  hardware_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS reliability_history_device_collected_idx
  ON device_reliability_history (device_id, collected_at);
CREATE INDEX IF NOT EXISTS reliability_history_org_collected_idx
  ON device_reliability_history (org_id, collected_at);

CREATE TABLE IF NOT EXISTS device_reliability (
  device_id UUID PRIMARY KEY REFERENCES devices(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  computed_at TIMESTAMP NOT NULL DEFAULT NOW(),

  reliability_score INTEGER NOT NULL,
  uptime_score INTEGER NOT NULL,
  crash_score INTEGER NOT NULL,
  hang_score INTEGER NOT NULL,
  service_failure_score INTEGER NOT NULL,
  hardware_error_score INTEGER NOT NULL,

  uptime_7d REAL NOT NULL,
  uptime_30d REAL NOT NULL,
  uptime_90d REAL NOT NULL,

  crash_count_7d INTEGER NOT NULL DEFAULT 0,
  crash_count_30d INTEGER NOT NULL DEFAULT 0,
  crash_count_90d INTEGER NOT NULL DEFAULT 0,

  hang_count_7d INTEGER NOT NULL DEFAULT 0,
  hang_count_30d INTEGER NOT NULL DEFAULT 0,

  service_failure_count_7d INTEGER NOT NULL DEFAULT 0,
  service_failure_count_30d INTEGER NOT NULL DEFAULT 0,

  hardware_error_count_7d INTEGER NOT NULL DEFAULT 0,
  hardware_error_count_30d INTEGER NOT NULL DEFAULT 0,

  mtbf_hours REAL,
  trend_direction trend_direction NOT NULL,
  trend_confidence REAL NOT NULL DEFAULT 0,
  top_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS reliability_org_score_idx
  ON device_reliability (org_id, reliability_score);
CREATE INDEX IF NOT EXISTS reliability_score_idx
  ON device_reliability (reliability_score);
CREATE INDEX IF NOT EXISTS reliability_trend_idx
  ON device_reliability (trend_direction);
