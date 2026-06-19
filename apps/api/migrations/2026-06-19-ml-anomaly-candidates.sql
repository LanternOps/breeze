CREATE TABLE IF NOT EXISTS metric_anomaly_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  source_table varchar(80) NOT NULL DEFAULT 'device_metrics',
  metric_type varchar(80) NOT NULL,
  metric_name varchar(120) NOT NULL,
  model_version varchar(80) NOT NULL,
  anomaly_type varchar(40) NOT NULL,
  window_start timestamp NOT NULL,
  window_end timestamp NOT NULL,
  bucket_seconds integer NOT NULL DEFAULT 300,
  observed_value double precision NOT NULL,
  baseline_value double precision,
  baseline_min double precision,
  baseline_max double precision,
  score double precision NOT NULL,
  confidence double precision NOT NULL,
  sample_count integer NOT NULL DEFAULT 0,
  baseline_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT metric_anomaly_candidates_source_table_chk CHECK (
    source_table IN ('device_metrics', 'device_process_samples', 'snmp_metrics')
  ),
  CONSTRAINT metric_anomaly_candidates_anomaly_type_chk CHECK (
    anomaly_type IN (
      'spike',
      'drop',
      'memory_growth',
      'disk_growth',
      'process_runaway',
      'network_egress'
    )
  ),
  CONSTRAINT metric_anomaly_candidates_bucket_seconds_chk CHECK (bucket_seconds IN (300, 3600, 86400)),
  CONSTRAINT metric_anomaly_candidates_window_chk CHECK (window_start < window_end),
  CONSTRAINT metric_anomaly_candidates_score_chk CHECK (score >= 0),
  CONSTRAINT metric_anomaly_candidates_confidence_chk CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT metric_anomaly_candidates_sample_count_chk CHECK (sample_count >= 0),
  CONSTRAINT metric_anomaly_candidates_baseline_summary_object_chk CHECK (jsonb_typeof(baseline_summary) = 'object'),
  CONSTRAINT metric_anomaly_candidates_evidence_object_chk CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT metric_anomaly_candidates_baseline_summary_size_chk CHECK (pg_column_size(baseline_summary) <= 8192),
  CONSTRAINT metric_anomaly_candidates_evidence_size_chk CHECK (pg_column_size(evidence) <= 8192)
);

CREATE UNIQUE INDEX IF NOT EXISTS metric_anomaly_candidates_key_uq
  ON metric_anomaly_candidates (
    org_id,
    device_id,
    source_table,
    metric_name,
    anomaly_type,
    model_version,
    bucket_seconds,
    window_start
  );

CREATE INDEX IF NOT EXISTS metric_anomaly_candidates_org_model_detected_idx
  ON metric_anomaly_candidates (org_id, model_version, detected_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomaly_candidates_device_model_detected_idx
  ON metric_anomaly_candidates (device_id, model_version, detected_at DESC);

ALTER TABLE metric_anomaly_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_anomaly_candidates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_metric_anomaly_candidates_select ON metric_anomaly_candidates;
CREATE POLICY breeze_org_isolation_metric_anomaly_candidates_select
  ON metric_anomaly_candidates
  FOR SELECT
  USING (breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_metric_anomaly_candidates_insert ON metric_anomaly_candidates;
CREATE POLICY breeze_org_isolation_metric_anomaly_candidates_insert
  ON metric_anomaly_candidates
  FOR INSERT
  WITH CHECK (breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_metric_anomaly_candidates_update ON metric_anomaly_candidates;
CREATE POLICY breeze_org_isolation_metric_anomaly_candidates_update
  ON metric_anomaly_candidates
  FOR UPDATE
  USING (breeze_has_org_access(org_id))
  WITH CHECK (breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_metric_anomaly_candidates_delete ON metric_anomaly_candidates;
CREATE POLICY breeze_org_isolation_metric_anomaly_candidates_delete
  ON metric_anomaly_candidates
  FOR DELETE
  USING (breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON metric_anomaly_candidates TO breeze_app;
