-- S1 Site-to-Organization mappings
-- Maps SentinelOne site names to Breeze organizations for multi-tenant agent routing
-- NOTE: integration_id does not cascade on delete; drop mappings manually before removing an integration.
BEGIN;

CREATE TABLE IF NOT EXISTS s1_site_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES s1_integrations(id),
  site_name VARCHAR(200) NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS s1_site_mappings_integration_site_idx
  ON s1_site_mappings (integration_id, site_name);

CREATE INDEX IF NOT EXISTS s1_site_mappings_org_idx
  ON s1_site_mappings (org_id);

-- Row-Level Security (matches pattern from 2026-02-26 migration)
ALTER TABLE s1_site_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_site_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON s1_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON s1_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON s1_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON s1_site_mappings;
CREATE POLICY breeze_org_isolation_select ON s1_site_mappings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON s1_site_mappings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON s1_site_mappings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON s1_site_mappings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
