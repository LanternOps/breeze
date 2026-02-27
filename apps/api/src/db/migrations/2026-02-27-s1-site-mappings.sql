-- S1 Site-to-Organization mappings
-- Maps SentinelOne site names to Breeze organizations for multi-tenant agent routing
CREATE TABLE IF NOT EXISTS s1_site_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES s1_integrations(id),
  site_name VARCHAR(200) NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS s1_site_mappings_integration_site_idx
  ON s1_site_mappings (integration_id, site_name);

CREATE INDEX IF NOT EXISTS s1_site_mappings_org_idx
  ON s1_site_mappings (org_id);
