-- Phase 1: network topology provenance (issue #1728)
-- Extends the existing network_topology table with method/confidence/created_by/first_seen_at
-- and a provenance unique index for idempotent measured-edge upserts.
-- interface_name already exists (baseline). RLS is re-asserted idempotently as defense-in-depth.

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS method text;

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS confidence text;

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS created_by uuid;

ALTER TABLE public.network_topology
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz DEFAULT now();

-- Backfill provenance for any pre-existing rows so the unique index can be built
-- without NULL-method collisions. Report the count for the forensic trail.
DO $$
DECLARE n integer;
BEGIN
  UPDATE public.network_topology SET method = 'manual' WHERE method IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled method=manual on % legacy network_topology row(s)', n; END IF;

  UPDATE public.network_topology SET confidence = 'asserted' WHERE confidence IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled confidence=asserted on % legacy network_topology row(s)', n; END IF;

  UPDATE public.network_topology SET first_seen_at = COALESCE(last_verified_at, created_at, now()) WHERE first_seen_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled first_seen_at on % legacy network_topology row(s)', n; END IF;
END $$;

-- Provenance unique index: lets a measured (method=lldp/cdp/fdb) and a manual edge
-- coexist on the same node pair; powers idempotent ON CONFLICT upsert on rescan.
CREATE UNIQUE INDEX IF NOT EXISTS ux_network_topology_provenance
  ON public.network_topology (org_id, site_id, source_type, source_id, target_type, target_id, method);

-- Defense-in-depth: re-assert RLS (already on per baseline). Idempotent.
ALTER TABLE public.network_topology ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_topology FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_select') THEN
    CREATE POLICY breeze_org_isolation_select ON public.network_topology FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_insert') THEN
    CREATE POLICY breeze_org_isolation_insert ON public.network_topology FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_update') THEN
    CREATE POLICY breeze_org_isolation_update ON public.network_topology FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='network_topology' AND policyname='breeze_org_isolation_delete') THEN
    CREATE POLICY breeze_org_isolation_delete ON public.network_topology FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
