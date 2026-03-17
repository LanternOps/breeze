BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dns_provider') THEN
    CREATE TYPE dns_provider AS ENUM ('umbrella', 'cloudflare', 'dnsfilter', 'pihole', 'opendns', 'quad9');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dns_action') THEN
    CREATE TYPE dns_action AS ENUM ('allowed', 'blocked', 'redirected');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dns_threat_category') THEN
    CREATE TYPE dns_threat_category AS ENUM (
      'malware',
      'phishing',
      'botnet',
      'cryptomining',
      'ransomware',
      'spam',
      'adware',
      'adult_content',
      'gambling',
      'social_media',
      'streaming',
      'unknown'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dns_policy_type') THEN
    CREATE TYPE dns_policy_type AS ENUM ('blocklist', 'allowlist');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dns_policy_sync_status') THEN
    CREATE TYPE dns_policy_sync_status AS ENUM ('pending', 'synced', 'error');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dns_filter_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  provider dns_provider NOT NULL,
  name varchar(200) NOT NULL,
  description text,
  api_key text,
  api_secret text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  last_sync timestamp,
  last_sync_status varchar(20),
  last_sync_error text,
  total_events_processed integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dns_filter_integrations_org_id_idx
  ON dns_filter_integrations (org_id);
CREATE INDEX IF NOT EXISTS dns_filter_integrations_provider_idx
  ON dns_filter_integrations (provider);

CREATE TABLE IF NOT EXISTS dns_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  integration_id uuid NOT NULL REFERENCES dns_filter_integrations(id),
  device_id uuid REFERENCES devices(id),
  timestamp timestamp NOT NULL,
  domain varchar(500) NOT NULL,
  query_type varchar(10) NOT NULL DEFAULT 'A',
  action dns_action NOT NULL,
  category dns_threat_category,
  threat_type varchar(100),
  threat_score integer,
  source_ip varchar(45),
  source_hostname varchar(255),
  provider_event_id varchar(255),
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dns_security_events_org_ts_idx
  ON dns_security_events (org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS dns_security_events_integration_id_idx
  ON dns_security_events (integration_id);
CREATE INDEX IF NOT EXISTS dns_security_events_device_id_idx
  ON dns_security_events (device_id);
CREATE INDEX IF NOT EXISTS dns_security_events_domain_idx
  ON dns_security_events (domain);
CREATE INDEX IF NOT EXISTS dns_security_events_action_cat_idx
  ON dns_security_events (action, category);
CREATE INDEX IF NOT EXISTS dns_security_events_provider_id_idx
  ON dns_security_events (integration_id, provider_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS dns_security_events_provider_evt_uniq
  ON dns_security_events (integration_id, provider_event_id);

CREATE TABLE IF NOT EXISTS dns_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  integration_id uuid NOT NULL REFERENCES dns_filter_integrations(id),
  name varchar(200) NOT NULL,
  description text,
  type dns_policy_type NOT NULL,
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  sync_status dns_policy_sync_status NOT NULL DEFAULT 'pending',
  last_synced timestamp,
  sync_error text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dns_policies_org_id_idx
  ON dns_policies (org_id);
CREATE INDEX IF NOT EXISTS dns_policies_integration_id_idx
  ON dns_policies (integration_id);

CREATE TABLE IF NOT EXISTS dns_event_aggregations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  date date NOT NULL,
  device_id uuid REFERENCES devices(id),
  domain varchar(500),
  category dns_threat_category,
  total_queries integer NOT NULL DEFAULT 0,
  blocked_queries integer NOT NULL DEFAULT 0,
  allowed_queries integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS dns_event_agg_org_date_idx
  ON dns_event_aggregations (org_id, date DESC);
CREATE INDEX IF NOT EXISTS dns_event_agg_device_id_idx
  ON dns_event_aggregations (device_id);

ALTER TABLE dns_filter_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dns_filter_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dns_filter_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dns_filter_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dns_filter_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dns_filter_integrations;
CREATE POLICY breeze_org_isolation_select ON dns_filter_integrations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON dns_filter_integrations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON dns_filter_integrations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON dns_filter_integrations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE dns_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dns_security_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dns_security_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dns_security_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dns_security_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dns_security_events;
CREATE POLICY breeze_org_isolation_select ON dns_security_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON dns_security_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON dns_security_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON dns_security_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE dns_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dns_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dns_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dns_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dns_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dns_policies;
CREATE POLICY breeze_org_isolation_select ON dns_policies
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON dns_policies
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON dns_policies
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON dns_policies
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE dns_event_aggregations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dns_event_aggregations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dns_event_aggregations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dns_event_aggregations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dns_event_aggregations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dns_event_aggregations;
CREATE POLICY breeze_org_isolation_select ON dns_event_aggregations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON dns_event_aggregations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON dns_event_aggregations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON dns_event_aggregations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
