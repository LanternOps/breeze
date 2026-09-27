-- #7036: deleting a discovery profile returned 500 once discovery had produced
-- anything. DELETE /discovery/profiles/:id removes the profile's discovery_jobs
-- and then the profile, but three nullable provenance pointers into those rows
-- were declared with no ON DELETE action (NO ACTION):
--
--   discovered_assets.last_job_id       -> discovery_jobs(id)
--   network_baselines.last_scan_job_id  -> discovery_jobs(id)
--   network_change_events.profile_id    -> discovery_profiles(id)
--
-- The rows carrying them are inventory and history that must outlive the
-- profile, so the pointer is cleared instead: ON DELETE SET NULL. (0025 intended
-- this for network_change_events.profile_id, but the baseline had already
-- created the column with a NO ACTION constraint, so its ADD COLUMN never took.)
--
-- Schema-only (no row writes). Idempotent: each column's FKs to the target are
-- dropped whatever their name unless already SET NULL, then the canonical
-- constraint is added if missing.

DO $$
DECLARE
  spec record;
  con record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('discovered_assets',     'last_job_id',      'discovery_jobs',     'discovered_assets_last_job_id_discovery_jobs_id_fk'),
      ('network_baselines',     'last_scan_job_id', 'discovery_jobs',     'network_baselines_last_scan_job_id_discovery_jobs_id_fk'),
      ('network_change_events', 'profile_id',       'discovery_profiles', 'network_change_events_profile_id_discovery_profiles_id_fk')
    ) AS s(tbl, col, ref_tbl, con_name)
  LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.conrelid = format('public.%I', spec.tbl)::regclass
         AND c.confrelid = format('public.%I', spec.ref_tbl)::regclass
         AND array_length(c.conkey, 1) = 1
         AND a.attname = spec.col
         AND (c.confdeltype <> 'n' OR c.conname <> spec.con_name)
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', spec.tbl, con.conname);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', spec.tbl)::regclass
         AND conname = spec.con_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE SET NULL',
        spec.tbl, spec.con_name, spec.col, spec.ref_tbl
      );
    END IF;
  END LOOP;
END $$;
