-- Time sync W01a (#7453): latest per-device time-service status (spec §D).
-- Direct org_id tenancy (shape 1) with a DEFERRABLE INITIALLY IMMEDIATE
-- composite (device_id, org_id) FK so org merge/move can re-point both sides.
-- Idempotent; writes no rows. W02 adds finding_streaks, W03a adds enforcement.
CREATE TABLE IF NOT EXISTS device_time_status (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0,
  collected_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  agent_version text,
  health text NOT NULL DEFAULT 'unknown',
  findings text[] NOT NULL DEFAULT '{}',
  finding_details jsonb NOT NULL DEFAULT '{}',
  sync_type text,
  ntp_server text,
  special_poll_interval_seconds integer,
  policy_managed boolean NOT NULL DEFAULT false,
  policy_managed_values text[] NOT NULL DEFAULT '{}',
  service_state text NOT NULL DEFAULT 'unknown',
  service_start_type text NOT NULL DEFAULT 'unknown',
  host_time_provider_enabled boolean,
  status_method text NOT NULL DEFAULT 'unavailable',
  source text,
  source_kind text NOT NULL DEFAULT 'unknown',
  last_successful_sync_at timestamptz,
  last_sync_error text,
  stratum integer,
  poll_interval_seconds integer,
  join_type text NOT NULL DEFAULT 'unknown',
  domain_role text NOT NULL DEFAULT 'unknown',
  domain_dns text,
  forest_dns text,
  pdc_name text,
  timezone_windows_id text,
  timezone_bias_minutes integer,
  timezone_auto_update text NOT NULL DEFAULT 'unknown',
  expected_timezone text,
  expected_timezone_windows_id text,
  expected_timezone_source text,
  event_marks jsonb NOT NULL DEFAULT '{}',
  recent_events jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_time_status_health_check CHECK (health IN ('healthy','warning','critical','unknown')),
  CONSTRAINT device_time_status_device_org_fkey FOREIGN KEY (device_id, org_id)
    REFERENCES devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
ALTER TABLE device_time_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_time_status FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_select') THEN
    CREATE POLICY device_time_status_select ON device_time_status FOR SELECT
      USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_insert') THEN
    CREATE POLICY device_time_status_insert ON device_time_status FOR INSERT
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_update') THEN
    CREATE POLICY device_time_status_update ON device_time_status FOR UPDATE
      USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_delete') THEN
    CREATE POLICY device_time_status_delete ON device_time_status FOR DELETE
      USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS device_time_status_org_health_idx ON device_time_status(org_id, health);
CREATE INDEX IF NOT EXISTS device_time_status_org_domain_idx ON device_time_status(org_id, domain_dns, domain_role);
CREATE INDEX IF NOT EXISTS device_time_status_findings_gin ON device_time_status USING gin(findings);
