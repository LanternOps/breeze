-- Service & Process Monitoring: enums, check results table, and config policy monitoring tables.
-- Run AFTER pnpm db:push has created these objects (this file satisfies the migration coverage check).

-- Enum: monitoring_watch_type
DO $$ BEGIN
  CREATE TYPE monitoring_watch_type AS ENUM ('service', 'process');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enum: check_result_status
DO $$ BEGIN
  CREATE TYPE check_result_status AS ENUM ('running', 'stopped', 'not_found', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Table: service_process_check_results
CREATE TABLE IF NOT EXISTS service_process_check_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  watch_type monitoring_watch_type NOT NULL,
  name VARCHAR(255) NOT NULL,
  status check_result_status NOT NULL,
  cpu_percent REAL,
  memory_mb REAL,
  pid INTEGER,
  details JSONB,
  auto_restart_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  auto_restart_succeeded BOOLEAN,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS spc_results_org_id_idx ON service_process_check_results (org_id);
CREATE INDEX IF NOT EXISTS spc_results_device_id_idx ON service_process_check_results (device_id);
CREATE INDEX IF NOT EXISTS spc_results_device_name_ts_idx ON service_process_check_results (device_id, name, timestamp);

-- Table: config_policy_monitoring_settings
CREATE TABLE IF NOT EXISTS config_policy_monitoring_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  check_interval_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: config_policy_monitoring_watches
CREATE TABLE IF NOT EXISTS config_policy_monitoring_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id UUID NOT NULL REFERENCES config_policy_monitoring_settings(id) ON DELETE CASCADE,
  watch_type monitoring_watch_type NOT NULL,
  name VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alert_on_stop BOOLEAN NOT NULL DEFAULT TRUE,
  alert_after_consecutive_failures INTEGER NOT NULL DEFAULT 2,
  alert_severity alert_severity NOT NULL DEFAULT 'high',
  cpu_threshold_percent REAL,
  memory_threshold_mb REAL,
  threshold_duration_seconds INTEGER NOT NULL DEFAULT 300,
  auto_restart BOOLEAN NOT NULL DEFAULT FALSE,
  max_restart_attempts INTEGER NOT NULL DEFAULT 3,
  restart_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cpmon_watches_settings_id_idx ON config_policy_monitoring_watches (settings_id);
