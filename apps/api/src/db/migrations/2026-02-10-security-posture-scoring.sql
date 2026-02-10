DO $$
BEGIN
  CREATE TYPE security_risk_level AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE security_status
  ADD COLUMN IF NOT EXISTS encryption_details JSONB,
  ADD COLUMN IF NOT EXISTS local_admin_summary JSONB,
  ADD COLUMN IF NOT EXISTS password_policy_summary JSONB;

CREATE TABLE IF NOT EXISTS security_posture_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
  overall_score INTEGER NOT NULL,
  risk_level security_risk_level NOT NULL,
  patch_compliance_score INTEGER NOT NULL,
  encryption_score INTEGER NOT NULL,
  av_health_score INTEGER NOT NULL,
  firewall_score INTEGER NOT NULL,
  open_ports_score INTEGER NOT NULL,
  password_policy_score INTEGER NOT NULL,
  os_currency_score INTEGER NOT NULL,
  admin_exposure_score INTEGER NOT NULL,
  factor_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS security_posture_snapshots_org_captured_idx
  ON security_posture_snapshots (org_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS security_posture_snapshots_device_captured_idx
  ON security_posture_snapshots (device_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS security_posture_snapshots_org_score_idx
  ON security_posture_snapshots (org_id, overall_score);

CREATE TABLE IF NOT EXISTS security_posture_org_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
  overall_score INTEGER NOT NULL,
  devices_audited INTEGER NOT NULL DEFAULT 0,
  low_risk_devices INTEGER NOT NULL DEFAULT 0,
  medium_risk_devices INTEGER NOT NULL DEFAULT 0,
  high_risk_devices INTEGER NOT NULL DEFAULT 0,
  critical_risk_devices INTEGER NOT NULL DEFAULT 0,
  patch_compliance_score INTEGER NOT NULL,
  encryption_score INTEGER NOT NULL,
  av_health_score INTEGER NOT NULL,
  firewall_score INTEGER NOT NULL,
  open_ports_score INTEGER NOT NULL,
  password_policy_score INTEGER NOT NULL,
  os_currency_score INTEGER NOT NULL,
  admin_exposure_score INTEGER NOT NULL,
  top_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS security_posture_org_snapshots_org_captured_idx
  ON security_posture_org_snapshots (org_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS security_posture_org_snapshots_org_score_idx
  ON security_posture_org_snapshots (org_id, overall_score);
