DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'psa_provider') THEN
    ALTER TYPE psa_provider ADD VALUE IF NOT EXISTS 'jira';
    ALTER TYPE psa_provider ADD VALUE IF NOT EXISTS 'servicenow';
    ALTER TYPE psa_provider ADD VALUE IF NOT EXISTS 'freshservice';
    ALTER TYPE psa_provider ADD VALUE IF NOT EXISTS 'zendesk';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'patch_compliance_report_status') THEN
    CREATE TYPE patch_compliance_report_status AS ENUM ('pending', 'running', 'completed', 'failed');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'patch_compliance_report_format') THEN
    CREATE TYPE patch_compliance_report_format AS ENUM ('csv', 'pdf');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS patch_compliance_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  requested_by UUID REFERENCES users(id),
  status patch_compliance_report_status NOT NULL DEFAULT 'pending',
  format patch_compliance_report_format NOT NULL DEFAULT 'csv',
  source patch_source,
  severity patch_severity,
  summary JSONB,
  row_count INTEGER,
  output_path TEXT,
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS patch_compliance_reports_org_created_idx
  ON patch_compliance_reports (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS patch_compliance_reports_status_created_idx
  ON patch_compliance_reports (status, created_at DESC);
