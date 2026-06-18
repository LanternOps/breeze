-- Remediation suggestions v0 (Phase 3).
-- Direct org_id RLS shape 1. Suggestions are read-only plans until existing
-- script/playbook execution rails are used explicitly.
-- Idempotent throughout. autoMigrate wraps this file in a transaction.

CREATE TABLE IF NOT EXISTS remediation_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  source_type VARCHAR(40) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  anomaly_id UUID REFERENCES metric_anomalies(id) ON DELETE SET NULL,
  correlation_group_id UUID REFERENCES alert_correlation_groups(id) ON DELETE SET NULL,
  rca_id VARCHAR(255),
  target_type VARCHAR(40) NOT NULL,
  script_id UUID REFERENCES scripts(id) ON DELETE SET NULL,
  script_template_id UUID REFERENCES script_templates(id) ON DELETE SET NULL,
  playbook_id UUID REFERENCES playbook_definitions(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  rationale TEXT NOT NULL,
  expected_action TEXT NOT NULL,
  risk_tier VARCHAR(20) NOT NULL DEFAULT 'medium',
  status VARCHAR(40) NOT NULL DEFAULT 'suggested',
  confidence DOUBLE PRECISION,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_device_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  elevation_request_id UUID REFERENCES elevation_requests(id) ON DELETE SET NULL,
  tool_execution_id UUID REFERENCES ai_tool_executions(id) ON DELETE SET NULL,
  script_execution_id UUID REFERENCES script_executions(id) ON DELETE SET NULL,
  playbook_execution_id UUID REFERENCES playbook_executions(id) ON DELETE SET NULL,
  edited_by UUID REFERENCES users(id),
  accepted_by UUID REFERENCES users(id),
  rejected_by UUID REFERENCES users(id),
  executed_by UUID REFERENCES users(id),
  failure_message TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  accepted_at TIMESTAMP,
  rejected_at TIMESTAMP,
  executed_at TIMESTAMP,
  CONSTRAINT remediation_suggestions_source_type_check CHECK (
    source_type IN ('alert', 'anomaly', 'correlation', 'rca')
  ),
  CONSTRAINT remediation_suggestions_target_type_check CHECK (
    target_type IN ('script', 'script_template', 'playbook', 'diagnostic')
  ),
  CONSTRAINT remediation_suggestions_status_check CHECK (
    status IN ('suggested', 'accepted', 'edited', 'rejected', 'executed', 'failed')
  ),
  CONSTRAINT remediation_suggestions_risk_tier_check CHECK (
    risk_tier IN ('low', 'medium', 'high', 'critical')
  ),
  CONSTRAINT remediation_suggestions_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT remediation_suggestions_evidence_object_check CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT remediation_suggestions_parameters_object_check CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT remediation_suggestions_evidence_size_check CHECK (octet_length(evidence::text) <= 8192),
  CONSTRAINT remediation_suggestions_parameters_size_check CHECK (octet_length(parameters::text) <= 8192),
  CONSTRAINT remediation_suggestions_target_check CHECK (
    (target_type = 'script' AND script_id IS NOT NULL)
    OR (target_type = 'script_template' AND script_template_id IS NOT NULL)
    OR (target_type = 'playbook' AND playbook_id IS NOT NULL)
    OR (target_type = 'diagnostic')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS remediation_suggestions_source_script_uq
  ON remediation_suggestions (org_id, source_type, source_id, script_id)
  WHERE target_type = 'script';

CREATE UNIQUE INDEX IF NOT EXISTS remediation_suggestions_source_template_uq
  ON remediation_suggestions (org_id, source_type, source_id, script_template_id)
  WHERE target_type = 'script_template';

CREATE UNIQUE INDEX IF NOT EXISTS remediation_suggestions_source_playbook_uq
  ON remediation_suggestions (org_id, source_type, source_id, playbook_id)
  WHERE target_type = 'playbook';

CREATE UNIQUE INDEX IF NOT EXISTS remediation_suggestions_source_diagnostic_uq
  ON remediation_suggestions (org_id, source_type, source_id, target_type)
  WHERE target_type = 'diagnostic';

CREATE INDEX IF NOT EXISTS remediation_suggestions_org_status_idx
  ON remediation_suggestions (org_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS remediation_suggestions_source_idx
  ON remediation_suggestions (org_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS remediation_suggestions_device_status_idx
  ON remediation_suggestions (device_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS remediation_suggestions_alert_idx
  ON remediation_suggestions (alert_id);

CREATE INDEX IF NOT EXISTS remediation_suggestions_anomaly_idx
  ON remediation_suggestions (anomaly_id);

ALTER TABLE remediation_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE remediation_suggestions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON remediation_suggestions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON remediation_suggestions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON remediation_suggestions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON remediation_suggestions;

CREATE POLICY breeze_org_isolation_select ON remediation_suggestions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON remediation_suggestions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON remediation_suggestions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON remediation_suggestions
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE remediation_suggestions TO breeze_app;
