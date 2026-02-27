BEGIN;

CREATE TABLE IF NOT EXISTS sensitive_data_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(200) NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  detection_classes jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sensitive_policy_org_idx
  ON sensitive_data_policies(org_id);

CREATE TABLE IF NOT EXISTS sensitive_data_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  policy_id uuid REFERENCES sensitive_data_policies(id),
  requested_by uuid REFERENCES users(id),
  status varchar(20) NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  idempotency_key varchar(128),
  request_fingerprint varchar(64),
  summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sensitive_scan_org_device_idx
  ON sensitive_data_scans(org_id, device_id);

CREATE INDEX IF NOT EXISTS sensitive_scan_status_idx
  ON sensitive_data_scans(status);

CREATE INDEX IF NOT EXISTS sensitive_scan_org_idempotency_idx
  ON sensitive_data_scans(org_id, idempotency_key);

CREATE TABLE IF NOT EXISTS sensitive_data_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  scan_id uuid NOT NULL REFERENCES sensitive_data_scans(id),
  file_path text NOT NULL,
  data_type varchar(20) NOT NULL,
  pattern_id varchar(80) NOT NULL,
  match_count integer NOT NULL DEFAULT 1,
  risk varchar(20) NOT NULL,
  confidence real NOT NULL DEFAULT 0.5,
  file_owner varchar(255),
  file_modified_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrence_count integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'open',
  remediation_action varchar(40),
  remediation_metadata jsonb,
  remediated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sensitive_findings_org_risk_idx
  ON sensitive_data_findings(org_id, risk);

CREATE INDEX IF NOT EXISTS sensitive_findings_scan_idx
  ON sensitive_data_findings(scan_id);

CREATE INDEX IF NOT EXISTS sensitive_findings_org_last_seen_idx
  ON sensitive_data_findings(org_id, last_seen_at);

CREATE UNIQUE INDEX IF NOT EXISTS sensitive_findings_open_dedupe_idx
  ON sensitive_data_findings(org_id, device_id, file_path, data_type, pattern_id)
  WHERE status = 'open';

ALTER TABLE sensitive_data_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sensitive_data_policies_org_isolation ON sensitive_data_policies;
CREATE POLICY sensitive_data_policies_org_isolation ON sensitive_data_policies
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

ALTER TABLE sensitive_data_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sensitive_data_scans_org_isolation ON sensitive_data_scans;
CREATE POLICY sensitive_data_scans_org_isolation ON sensitive_data_scans
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

ALTER TABLE sensitive_data_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sensitive_data_findings_org_isolation ON sensitive_data_findings;
CREATE POLICY sensitive_data_findings_org_isolation ON sensitive_data_findings
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

COMMIT;
