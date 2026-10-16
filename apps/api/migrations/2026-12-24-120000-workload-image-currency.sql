-- Workload host inventory W05 (#8194, image currency #3813, spec §9).
--
-- 1. device_workloads gains the per-row upstream comparison the
--    imageCurrencyWorker writes (spec §9.1 status vocabulary). The columns are
--    tenant data on a tenant table: they inherit device_workloads' forced RLS.
-- 2. container_image_upstream_cache: a GLOBAL cache of what public registries
--    serve for a repo:tag (spec §9.3). No tenant column. Forced RLS with a
--    single SYSTEM-ONLY policy and no permissive SELECT: the rows are derived
--    from what tenants run, so no tenant context may read them. Rows are only
--    ever written for anonymous lookups that succeeded (verifiably public).
--
-- Idempotent; writes no rows (no breeze.scope preamble needed).

ALTER TABLE public.device_workloads
  ADD COLUMN IF NOT EXISTS upstream_status varchar(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS upstream_digest varchar(80),
  ADD COLUMN IF NOT EXISTS upstream_checked_at timestamp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'device_workloads_upstream_status_chk'
      AND conrelid = 'public.device_workloads'::regclass
  ) THEN
    ALTER TABLE public.device_workloads
      ADD CONSTRAINT device_workloads_upstream_status_chk CHECK (
        upstream_status IN (
          'pending', 'current', 'behind', 'pinned', 'local',
          'private', 'unsupported_registry', 'not_found', 'error'
        )
      );
  END IF;
END $$;

-- The worker's due scan (spec §9.3): container rows by when they were last
-- checked. NULL = never checked (new rows, and rows ingest reset to pending).
CREATE INDEX IF NOT EXISTS device_workloads_upstream_due_idx
  ON public.device_workloads (upstream_checked_at NULLS FIRST)
  WHERE kind = 'container';

CREATE TABLE IF NOT EXISTS public.container_image_upstream_cache (
  registry varchar(255) NOT NULL,
  repository varchar(400) NOT NULL,
  tag varchar(128) NOT NULL,
  digest varchar(80) NOT NULL,
  media_type varchar(255),
  platform_digests varchar(80)[],
  checked_at timestamp NOT NULL,
  expires_at timestamp NOT NULL,
  CONSTRAINT container_image_upstream_cache_pkey PRIMARY KEY (registry, repository, tag)
);

CREATE INDEX IF NOT EXISTS container_image_upstream_cache_expires_idx
  ON public.container_image_upstream_cache (expires_at);

ALTER TABLE public.container_image_upstream_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.container_image_upstream_cache FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_system_only ON public.container_image_upstream_cache;
CREATE POLICY breeze_system_only ON public.container_image_upstream_cache
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.container_image_upstream_cache TO breeze_app;
  END IF;
END $$;
