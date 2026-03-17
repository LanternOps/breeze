BEGIN;

CREATE TABLE IF NOT EXISTS huntress_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(200) NOT NULL,
  api_key_encrypted text NOT NULL,
  account_id varchar(120),
  api_base_url varchar(300) NOT NULL DEFAULT 'https://api.huntress.io/v1',
  webhook_secret_encrypted text,
  is_active boolean NOT NULL DEFAULT true,
  last_sync_at timestamp,
  last_sync_status varchar(20),
  last_sync_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS huntress_integrations_org_idx
  ON huntress_integrations (org_id);

CREATE TABLE IF NOT EXISTS huntress_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  integration_id uuid NOT NULL REFERENCES huntress_integrations(id) ON DELETE CASCADE,
  huntress_agent_id varchar(128) NOT NULL,
  device_id uuid REFERENCES devices(id),
  hostname varchar(255),
  platform varchar(32),
  status varchar(20),
  last_seen_at timestamp,
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS huntress_agents_agent_id_idx
  ON huntress_agents (integration_id, huntress_agent_id);
CREATE INDEX IF NOT EXISTS huntress_agents_org_device_idx
  ON huntress_agents (org_id, device_id);

CREATE TABLE IF NOT EXISTS huntress_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  integration_id uuid NOT NULL REFERENCES huntress_integrations(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id),
  huntress_incident_id varchar(128) NOT NULL,
  severity varchar(20),
  category varchar(60),
  title text NOT NULL,
  description text,
  recommendation text,
  status varchar(30) NOT NULL,
  reported_at timestamp,
  resolved_at timestamp,
  details jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS huntress_incidents_external_idx
  ON huntress_incidents (integration_id, huntress_incident_id);
CREATE INDEX IF NOT EXISTS huntress_incidents_org_status_idx
  ON huntress_incidents (org_id, status);

ALTER TABLE huntress_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE huntress_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON huntress_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON huntress_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON huntress_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON huntress_integrations;
CREATE POLICY breeze_org_isolation_select ON huntress_integrations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON huntress_integrations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON huntress_integrations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON huntress_integrations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE huntress_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE huntress_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON huntress_agents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON huntress_agents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON huntress_agents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON huntress_agents;
CREATE POLICY breeze_org_isolation_select ON huntress_agents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON huntress_agents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON huntress_agents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON huntress_agents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE huntress_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE huntress_incidents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON huntress_incidents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON huntress_incidents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON huntress_incidents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON huntress_incidents;
CREATE POLICY breeze_org_isolation_select ON huntress_incidents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON huntress_incidents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON huntress_incidents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON huntress_incidents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
