-- Metric anomaly episodes (W01) — spec
-- docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md §4, §14.
--
-- One row per contiguous run of anomalous 5-minute buckets for a
-- (device, episode_key). metric_anomalies rows stay the per-bucket evidence and
-- gain episode_id. metric_anomaly_incidents keeps its per-bucket dispatch-outbox
-- grain and gains episode_id (no FK, same cycle-avoidance as agent_run_id) plus
-- suppressed_by_episode, both used by W02.
--
-- Tenancy shape 1 (direct org_id): RLS enabled + forced + four org-isolation
-- policies in THIS file. The file writes no rows, so it needs no breeze.scope
-- elevation. Idempotent throughout; autoMigrate wraps it in a transaction.
-- Plain inline CREATE INDEX (not the concurrent form): metric_anomalies holds tens of
-- thousands of rows per busy partner, not millions (spec §14 item 6).

CREATE TABLE IF NOT EXISTS metric_anomaly_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  episode_key VARCHAR(200) NOT NULL,
  source_table VARCHAR(40) NOT NULL,
  anomaly_type VARCHAR(40) NOT NULL,
  metric_family VARCHAR(120) NOT NULL,
  metric_names TEXT[] NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  close_reason VARCHAR(30),
  first_seen_at TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL,
  bucket_count INTEGER NOT NULL,
  peak_value DOUBLE PRECISION NOT NULL,
  peak_metric_name VARCHAR(120) NOT NULL,
  peak_baseline_value DOUBLE PRECISION,
  peak_score DOUBLE PRECISION NOT NULL,
  peak_at TIMESTAMP NOT NULL,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  attribution JSONB,
  linked_alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  snoozed_until TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT metric_anomaly_episodes_status_check CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT metric_anomaly_episodes_close_reason_check CHECK (
    close_reason IS NULL OR close_reason IN ('cleared', 'expired_offline', 'expired_no_data', 'detection_off', 'user', 'snoozed')
  ),
  CONSTRAINT metric_anomaly_episodes_open_close_reason_check CHECK ((status = 'open') = (close_reason IS NULL)),
  CONSTRAINT metric_anomaly_episodes_window_check CHECK (first_seen_at < last_seen_at),
  CONSTRAINT metric_anomaly_episodes_bucket_count_check CHECK (bucket_count >= 1),
  CONSTRAINT metric_anomaly_episodes_recurrence_check CHECK (recurrence_count >= 0),
  CONSTRAINT metric_anomaly_episodes_source_table_check CHECK (
    source_table IN ('device_metrics', 'snmp_metrics', 'device_process_samples')
  ),
  CONSTRAINT metric_anomaly_episodes_type_check CHECK (
    anomaly_type IN ('spike', 'drop', 'trend', 'process_runaway', 'network_egress', 'memory_growth', 'disk_growth')
  ),
  CONSTRAINT metric_anomaly_episodes_attribution_object_check CHECK (
    attribution IS NULL OR jsonb_typeof(attribution) = 'object'
  ),
  CONSTRAINT metric_anomaly_episodes_attribution_size_check CHECK (
    attribution IS NULL OR octet_length(attribution::text) <= 8192
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS metric_anomaly_episodes_open_key_uq
  ON metric_anomaly_episodes (device_id, episode_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_org_status_last_seen_idx
  ON metric_anomaly_episodes (org_id, status, last_seen_at);

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_device_key_resolved_idx
  ON metric_anomaly_episodes (device_id, episode_key, resolved_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_device_status_last_seen_idx
  ON metric_anomaly_episodes (device_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_linked_alert_idx
  ON metric_anomaly_episodes (linked_alert_id);

ALTER TABLE metric_anomaly_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_anomaly_episodes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON metric_anomaly_episodes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON metric_anomaly_episodes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON metric_anomaly_episodes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON metric_anomaly_episodes;

CREATE POLICY breeze_org_isolation_select ON metric_anomaly_episodes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON metric_anomaly_episodes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON metric_anomaly_episodes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON metric_anomaly_episodes
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE metric_anomaly_episodes TO breeze_app;

-- metric_anomalies: episode link, `cleared` status, assembly + anti-contamination indexes.
ALTER TABLE metric_anomalies ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES metric_anomaly_episodes(id) ON DELETE SET NULL;

ALTER TABLE metric_anomalies DROP CONSTRAINT IF EXISTS metric_anomalies_status_check;
ALTER TABLE metric_anomalies ADD CONSTRAINT metric_anomalies_status_check
  CHECK (status IN ('open', 'dismissed', 'promoted', 'resolved', 'cleared'));

CREATE INDEX IF NOT EXISTS metric_anomalies_episode_id_idx
  ON metric_anomalies (episode_id);

CREATE INDEX IF NOT EXISTS metric_anomalies_unassigned_open_idx
  ON metric_anomalies (org_id, device_id, window_start)
  WHERE episode_id IS NULL AND status = 'open';

CREATE INDEX IF NOT EXISTS metric_anomalies_device_metric_window_idx
  ON metric_anomalies (device_id, metric_name, window_start)
  WHERE episode_id IS NOT NULL;

-- metric_anomaly_incidents: W02 dispatch-per-episode columns. No FK on
-- episode_id (see metricAnomalyIncidents.ts header: FK cycles break
-- topologicalCascadeOrder()).
ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS episode_id UUID;
ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS suppressed_by_episode BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS metric_anomaly_incidents_episode_id_idx
  ON metric_anomaly_incidents (episode_id);
