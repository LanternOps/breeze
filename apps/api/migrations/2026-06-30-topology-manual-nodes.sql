-- Phase 4 (#1728): manual topology placeholder nodes. RLS shape 1 (org_id-direct).
CREATE TABLE IF NOT EXISTS public.topology_manual_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  label text NOT NULL,
  role text NOT NULL,
  notes text,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Constrain role to the locked enum set (idempotent re-add).
DO $$ BEGIN
  ALTER TABLE public.topology_manual_nodes DROP CONSTRAINT IF EXISTS topology_manual_nodes_role_chk;
  ALTER TABLE public.topology_manual_nodes
    ADD CONSTRAINT topology_manual_nodes_role_chk
    CHECK (role IN ('switch','router','ap','firewall','patch_panel','other'));
END $$;

CREATE INDEX IF NOT EXISTS topology_manual_nodes_org_site_idx
  ON public.topology_manual_nodes (org_id, site_id);

-- RLS shape 1: enable + force + breeze_has_org_access policies (same migration).
ALTER TABLE public.topology_manual_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topology_manual_nodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.topology_manual_nodes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.topology_manual_nodes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.topology_manual_nodes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.topology_manual_nodes;
CREATE POLICY breeze_org_isolation_select ON public.topology_manual_nodes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.topology_manual_nodes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.topology_manual_nodes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.topology_manual_nodes
  FOR DELETE USING (public.breeze_has_org_access(org_id));
