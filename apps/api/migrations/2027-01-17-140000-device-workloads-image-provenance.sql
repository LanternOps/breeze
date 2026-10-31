-- Workload inventory: image provenance evidence (#9067).
--
-- 1. device_workloads.image_provenance: the agent's evidence for where a
--    container's image came from: 'confirmed' (a registry digest the engine
--    vouches for), 'local' (never pulled from this repository) or 'unknown'
--    (the engine cannot say: Docker's containerd image store before Engine API
--    1.54). NULL = an agent that predates the field; behaviour is unchanged
--    for those rows. Additive, nullable, no backfill. The column is tenant
--    data on a tenant table and inherits device_workloads' forced RLS.
-- 2. upstream_status gains 'provenance_unknown': the image-currency worker
--    never sends an image whose provenance is unknown to any registry, so its
--    name cannot leak to a third party; it shows as Not checked.
--
-- Idempotent; writes no rows (no breeze.scope preamble needed).

ALTER TABLE public.device_workloads
  ADD COLUMN IF NOT EXISTS image_provenance varchar(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'device_workloads_image_provenance_chk'
      AND conrelid = 'public.device_workloads'::regclass
  ) THEN
    ALTER TABLE public.device_workloads
      ADD CONSTRAINT device_workloads_image_provenance_chk CHECK (
        image_provenance IS NULL OR image_provenance IN ('confirmed', 'local', 'unknown')
      );
  END IF;
END $$;

-- Widen the status vocabulary. Every existing value stays valid, so the
-- re-added constraint validates without touching a row.
ALTER TABLE public.device_workloads
  DROP CONSTRAINT IF EXISTS device_workloads_upstream_status_chk;
ALTER TABLE public.device_workloads
  ADD CONSTRAINT device_workloads_upstream_status_chk CHECK (
    upstream_status IN (
      'pending', 'current', 'behind', 'pinned', 'local',
      'private', 'unsupported_registry', 'not_found', 'error',
      'provenance_unknown'
    )
  );
