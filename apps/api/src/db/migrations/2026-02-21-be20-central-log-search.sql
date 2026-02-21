CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE device_event_logs
ADD COLUMN IF NOT EXISTS search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(source, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(message, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(event_id, '')), 'C')
) STORED;

CREATE INDEX IF NOT EXISTS device_event_logs_search_vector_idx
  ON device_event_logs USING gin(search_vector);
CREATE INDEX IF NOT EXISTS device_event_logs_message_trgm_idx
  ON device_event_logs USING gin(message gin_trgm_ops);
CREATE INDEX IF NOT EXISTS device_event_logs_source_trgm_idx
  ON device_event_logs USING gin(source gin_trgm_ops);

CREATE TABLE IF NOT EXISTS log_search_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  filters JSONB NOT NULL,
  created_by UUID REFERENCES users(id),
  is_shared BOOLEAN NOT NULL DEFAULT false,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS log_search_queries_org_id_idx ON log_search_queries(org_id);
CREATE INDEX IF NOT EXISTS log_search_queries_created_by_idx ON log_search_queries(created_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'log_correlation_severity'
  ) THEN
    CREATE TYPE log_correlation_severity AS ENUM ('info', 'warning', 'error', 'critical');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'log_correlation_status'
  ) THEN
    CREATE TYPE log_correlation_status AS ENUM ('active', 'resolved', 'ignored');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS log_correlation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  pattern TEXT NOT NULL,
  is_regex BOOLEAN NOT NULL DEFAULT false,
  min_occurrences INTEGER NOT NULL DEFAULT 3,
  min_devices INTEGER NOT NULL DEFAULT 2,
  time_window INTEGER NOT NULL DEFAULT 300,
  severity log_correlation_severity NOT NULL DEFAULT 'warning',
  alert_on_match BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_matched_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE log_correlation_rules
ADD COLUMN IF NOT EXISTS is_regex BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS log_correlation_rules_org_id_idx ON log_correlation_rules(org_id);
CREATE INDEX IF NOT EXISTS log_correlation_rules_active_idx ON log_correlation_rules(is_active);

CREATE TABLE IF NOT EXISTS log_correlations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  rule_id UUID NOT NULL REFERENCES log_correlation_rules(id),
  pattern TEXT NOT NULL,
  first_seen TIMESTAMP NOT NULL,
  last_seen TIMESTAMP NOT NULL,
  occurrences INTEGER NOT NULL,
  affected_devices JSONB NOT NULL,
  sample_logs JSONB,
  alert_id UUID REFERENCES alerts(id),
  status log_correlation_status NOT NULL DEFAULT 'active',
  resolved_at TIMESTAMP,
  resolved_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS log_correlations_org_id_idx ON log_correlations(org_id);
CREATE INDEX IF NOT EXISTS log_correlations_rule_id_idx ON log_correlations(rule_id);
CREATE INDEX IF NOT EXISTS log_correlations_status_idx ON log_correlations(status);
