-- Canonical metric rollups foundation (Phase 1 / C4).
-- Direct org_id RLS shape 1. Partitioned by bucket_start from day one.
-- Idempotent throughout. autoMigrate wraps this file in a transaction.

CREATE TABLE IF NOT EXISTS metric_rollups (
  org_id UUID NOT NULL REFERENCES organizations(id),
  source_table VARCHAR(80) NOT NULL,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  metric_type VARCHAR(80) NOT NULL,
  metric_name VARCHAR(120) NOT NULL,
  bucket_start TIMESTAMP NOT NULL,
  bucket_seconds INTEGER NOT NULL,
  avg_value DOUBLE PRECISION,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  p95_value DOUBLE PRECISION,
  sum_value DOUBLE PRECISION,
  sample_count INTEGER NOT NULL DEFAULT 0,
  gap_seconds INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT metric_rollups_source_table_check CHECK (
    source_table IN ('device_metrics', 'snmp_metrics', 'device_process_samples')
  ),
  CONSTRAINT metric_rollups_bucket_seconds_check CHECK (bucket_seconds IN (300, 3600, 86400)),
  CONSTRAINT metric_rollups_sample_count_check CHECK (sample_count >= 0),
  CONSTRAINT metric_rollups_gap_seconds_check CHECK (gap_seconds >= 0),
  CONSTRAINT metric_rollups_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT metric_rollups_metadata_size_check CHECK (octet_length(metadata::text) <= 8192),
  -- Avoid deriving p95-of-p95s. Phase 1 computes p95 only for raw 5-minute buckets.
  CONSTRAINT metric_rollups_p95_raw_bucket_check CHECK (
    p95_value IS NULL OR bucket_seconds = 300
  )
) PARTITION BY RANGE (bucket_start);

CREATE TABLE IF NOT EXISTS metric_rollups_default
  PARTITION OF metric_rollups DEFAULT;

CREATE UNIQUE INDEX IF NOT EXISTS metric_rollups_key_uq
  ON metric_rollups (
    org_id,
    source_table,
    device_id,
    metric_type,
    metric_name,
    bucket_seconds,
    bucket_start
  );

CREATE INDEX IF NOT EXISTS metric_rollups_org_bucket_idx
  ON metric_rollups (org_id, bucket_seconds, bucket_start DESC);

CREATE INDEX IF NOT EXISTS metric_rollups_device_metric_idx
  ON metric_rollups (device_id, metric_name, bucket_seconds, bucket_start DESC);

ALTER TABLE metric_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_rollups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON metric_rollups;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON metric_rollups;
DROP POLICY IF EXISTS breeze_org_isolation_update ON metric_rollups;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON metric_rollups;

CREATE POLICY breeze_org_isolation_select ON metric_rollups
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON metric_rollups
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON metric_rollups
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON metric_rollups
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE metric_rollups_default ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_rollups_default FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON metric_rollups_default;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON metric_rollups_default;
DROP POLICY IF EXISTS breeze_org_isolation_update ON metric_rollups_default;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON metric_rollups_default;

CREATE POLICY breeze_org_isolation_select ON metric_rollups_default
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON metric_rollups_default
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON metric_rollups_default
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON metric_rollups_default
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE metric_rollups TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE metric_rollups_default TO breeze_app;
