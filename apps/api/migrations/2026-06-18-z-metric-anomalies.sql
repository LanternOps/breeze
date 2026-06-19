-- Metric anomaly detection output (Phase 3).
-- Direct org_id RLS shape 1. Idempotent throughout.
-- autoMigrate wraps this file in a transaction.

CREATE TABLE IF NOT EXISTS metric_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  source_table VARCHAR(80) NOT NULL DEFAULT 'device_metrics',
  metric_type VARCHAR(80) NOT NULL,
  metric_name VARCHAR(120) NOT NULL,
  anomaly_type VARCHAR(40) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'open',
  window_start TIMESTAMP NOT NULL,
  window_end TIMESTAMP NOT NULL,
  bucket_seconds INTEGER NOT NULL DEFAULT 300,
  observed_value DOUBLE PRECISION NOT NULL,
  baseline_value DOUBLE PRECISION,
  baseline_min DOUBLE PRECISION,
  baseline_max DOUBLE PRECISION,
  score DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  baseline_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  linked_correlation_group_id UUID REFERENCES alert_correlation_groups(id) ON DELETE SET NULL,
  detected_at TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT metric_anomalies_source_table_check CHECK (
    source_table IN ('device_metrics', 'snmp_metrics', 'device_process_samples')
  ),
  CONSTRAINT metric_anomalies_type_check CHECK (
    anomaly_type IN ('spike', 'drop', 'trend', 'process_runaway', 'network_egress', 'memory_growth', 'disk_growth')
  ),
  CONSTRAINT metric_anomalies_status_check CHECK (
    status IN ('open', 'dismissed', 'promoted', 'resolved')
  ),
  CONSTRAINT metric_anomalies_bucket_seconds_check CHECK (bucket_seconds IN (300, 3600, 86400)),
  CONSTRAINT metric_anomalies_window_check CHECK (window_start < window_end),
  CONSTRAINT metric_anomalies_score_check CHECK (score >= 0),
  CONSTRAINT metric_anomalies_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT metric_anomalies_sample_count_check CHECK (sample_count >= 0),
  CONSTRAINT metric_anomalies_baseline_summary_object_check CHECK (jsonb_typeof(baseline_summary) = 'object'),
  CONSTRAINT metric_anomalies_evidence_object_check CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT metric_anomalies_baseline_summary_size_check CHECK (octet_length(baseline_summary::text) <= 8192),
  CONSTRAINT metric_anomalies_evidence_size_check CHECK (octet_length(evidence::text) <= 8192)
);

CREATE UNIQUE INDEX IF NOT EXISTS metric_anomalies_key_uq
  ON metric_anomalies (
    org_id,
    device_id,
    metric_name,
    anomaly_type,
    bucket_seconds,
    window_start
  );

CREATE INDEX IF NOT EXISTS metric_anomalies_org_status_detected_idx
  ON metric_anomalies (org_id, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomalies_device_status_detected_idx
  ON metric_anomalies (device_id, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomalies_linked_alert_idx
  ON metric_anomalies (linked_alert_id);

CREATE INDEX IF NOT EXISTS metric_anomalies_linked_correlation_idx
  ON metric_anomalies (linked_correlation_group_id);

ALTER TABLE metric_anomalies ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_anomalies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON metric_anomalies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON metric_anomalies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON metric_anomalies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON metric_anomalies;

CREATE POLICY breeze_org_isolation_select ON metric_anomalies
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON metric_anomalies
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON metric_anomalies
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON metric_anomalies
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE metric_anomalies TO breeze_app;
