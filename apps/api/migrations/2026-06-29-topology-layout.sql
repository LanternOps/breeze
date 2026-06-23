-- topology_layout: saved Cytoscape node positions (Phase 3, issue #1728).
-- org_id-direct (RLS shape 1): enable+force+policies in this migration.

CREATE TABLE IF NOT EXISTS topology_layout (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  site_id UUID NOT NULL REFERENCES sites(id),
  node_type TEXT NOT NULL,
  node_id UUID NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- node_type guard (idempotent drop-then-add)
DO $$ BEGIN
  ALTER TABLE topology_layout DROP CONSTRAINT IF EXISTS chk_topology_layout_node_type;
  ALTER TABLE topology_layout ADD CONSTRAINT chk_topology_layout_node_type
    CHECK (node_type IN ('discovered_asset','manual_node'));
END $$;

-- upsert key (LOCKED: site_id, node_type, node_id)
CREATE UNIQUE INDEX IF NOT EXISTS topology_layout_site_node_unique
  ON topology_layout (site_id, node_type, node_id);

-- RLS shape 1: direct org_id -> breeze_has_org_access(org_id)
ALTER TABLE topology_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_layout FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON topology_layout;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON topology_layout;
DROP POLICY IF EXISTS breeze_org_isolation_update ON topology_layout;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON topology_layout;
CREATE POLICY breeze_org_isolation_select ON topology_layout FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON topology_layout FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON topology_layout FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON topology_layout FOR DELETE
  USING (public.breeze_has_org_access(org_id));
