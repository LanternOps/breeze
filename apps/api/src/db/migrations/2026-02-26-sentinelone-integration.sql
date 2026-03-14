BEGIN;

CREATE TABLE IF NOT EXISTS s1_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(200) NOT NULL,
  api_token_encrypted text NOT NULL,
  management_url text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_sync_at timestamp,
  last_sync_status varchar(20),
  last_sync_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS s1_integrations_org_idx
  ON s1_integrations (org_id);

CREATE TABLE IF NOT EXISTS s1_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  integration_id uuid NOT NULL REFERENCES s1_integrations(id),
  s1_agent_id varchar(128) NOT NULL,
  device_id uuid REFERENCES devices(id),
  status varchar(30),
  infected boolean NOT NULL DEFAULT false,
  threat_count integer NOT NULL DEFAULT 0,
  policy_name varchar(200),
  last_seen_at timestamp,
  metadata jsonb,
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Re-create unique index to support idempotent migration reruns
DROP INDEX IF EXISTS s1_agents_external_idx;
CREATE UNIQUE INDEX s1_agents_external_idx
  ON s1_agents (integration_id, s1_agent_id);
CREATE INDEX IF NOT EXISTS s1_agents_org_device_idx
  ON s1_agents (org_id, device_id);
CREATE INDEX IF NOT EXISTS s1_agents_integration_idx
  ON s1_agents (integration_id);

CREATE TABLE IF NOT EXISTS s1_threats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  integration_id uuid NOT NULL REFERENCES s1_integrations(id),
  device_id uuid REFERENCES devices(id),
  s1_threat_id varchar(128) NOT NULL,
  classification varchar(60),
  severity varchar(20),
  threat_name text,
  process_name text,
  file_path text,
  mitre_tactics jsonb,
  status varchar(30) NOT NULL,
  detected_at timestamp,
  resolved_at timestamp,
  details jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Re-create unique index to support idempotent migration reruns
DROP INDEX IF EXISTS s1_threats_external_idx;
CREATE UNIQUE INDEX s1_threats_external_idx
  ON s1_threats (integration_id, s1_threat_id);
CREATE INDEX IF NOT EXISTS s1_threats_org_status_idx
  ON s1_threats (org_id, status);
CREATE INDEX IF NOT EXISTS s1_threats_org_severity_status_idx
  ON s1_threats (org_id, severity, status);
CREATE INDEX IF NOT EXISTS s1_threats_integration_idx
  ON s1_threats (integration_id);
CREATE INDEX IF NOT EXISTS s1_threats_integration_detected_idx
  ON s1_threats (integration_id, detected_at);
CREATE INDEX IF NOT EXISTS s1_threats_device_idx
  ON s1_threats (device_id);

CREATE TABLE IF NOT EXISTS s1_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid REFERENCES devices(id),
  requested_by uuid REFERENCES users(id),
  action varchar(40) NOT NULL,
  payload jsonb,
  status varchar(20) NOT NULL DEFAULT 'queued',
  provider_action_id varchar(128),
  requested_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  error text
);

CREATE INDEX IF NOT EXISTS s1_actions_org_status_idx
  ON s1_actions (org_id, status);
CREATE INDEX IF NOT EXISTS s1_actions_provider_action_idx
  ON s1_actions (provider_action_id);

ALTER TABLE s1_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON s1_integrations;
CREATE POLICY breeze_org_isolation_select ON s1_integrations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON s1_integrations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON s1_integrations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON s1_integrations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE s1_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON s1_agents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON s1_agents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON s1_agents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON s1_agents;
CREATE POLICY breeze_org_isolation_select ON s1_agents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON s1_agents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON s1_agents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON s1_agents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE s1_threats ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_threats FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON s1_threats;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON s1_threats;
DROP POLICY IF EXISTS breeze_org_isolation_update ON s1_threats;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON s1_threats;
CREATE POLICY breeze_org_isolation_select ON s1_threats
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON s1_threats
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON s1_threats
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON s1_threats
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE s1_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON s1_actions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON s1_actions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON s1_actions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON s1_actions;
CREATE POLICY breeze_org_isolation_select ON s1_actions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON s1_actions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON s1_actions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON s1_actions
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
