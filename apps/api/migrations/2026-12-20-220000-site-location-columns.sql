-- @no-transaction
-- #4186 W1: site pin columns + time-entry site link (location-aware time
-- suggestions). The only coordinate stored server-side is a deliberately
-- pinned SITE location; no technician position is ever written. Every column
-- is nullable with no default: no backfill, no table rewrite, existing rows
-- untouched. No UPDATE/INSERT here, so no breeze.scope elevation is needed.
--
-- Locking (outside a transaction, each statement sent on its own):
--   * ADD COLUMN (nullable, no default) is catalog-only.
--   * The four sites CHECKs are drop+add on `sites` (a small table): each takes
--     a brief ACCESS EXCLUSIVE lock plus a scan, bounded by lock_timeout.
--   * Both FKs are added NOT VALID, guarded by a pg_constraint existence check
--     instead of DROP + ADD (a DROP CONSTRAINT would take ACCESS EXCLUSIVE on
--     the hot time_entries table). ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on
--     both the child and the parent (catalog only while NOT VALID; new rows are
--     still checked and ON DELETE SET NULL still fires). VALIDATE CONSTRAINT is
--     a separate statement taking SHARE UPDATE EXCLUSIVE on the child, so writes
--     continue during the scan. lock_timeout bounds each lock wait so a queued
--     request cannot stall heartbeats or logins. On failure autoMigrate aborts
--     boot and the file re-runs cleanly.
--   * The partial index is built CONCURRENTLY (permitted here), so time_entries
--     keeps taking writes; a DO block then fails loudly if an interrupted build
--     left an INVALID index (IF NOT EXISTS would otherwise accept it).
-- Idempotent: every DDL statement is IF NOT EXISTS / existence-guarded, or DROP IF EXISTS + re-add (sites CHECKs).
-- time_entries.site_id is informational only and does not participate in RLS
-- (time_entries is partner-axis); sites.org_id remains the tenancy anchor.
--
-- location_set_by ON DELETE SET NULL: a user delete must not block on a pin.

SET lock_timeout = '5s';

ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS latitude numeric(9,6);
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS geofence_radius_m integer;
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS location_source varchar(16);
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS location_set_by uuid;
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS location_set_at timestamptz;

ALTER TABLE public.sites DROP CONSTRAINT IF EXISTS sites_location_pair_chk;
ALTER TABLE public.sites ADD CONSTRAINT sites_location_pair_chk
  CHECK ((latitude IS NULL) = (longitude IS NULL));
ALTER TABLE public.sites DROP CONSTRAINT IF EXISTS sites_location_range_chk;
ALTER TABLE public.sites ADD CONSTRAINT sites_location_range_chk
  CHECK ((latitude IS NULL OR latitude BETWEEN -90 AND 90)
     AND (longitude IS NULL OR longitude BETWEEN -180 AND 180));
ALTER TABLE public.sites DROP CONSTRAINT IF EXISTS sites_geofence_radius_chk;
ALTER TABLE public.sites ADD CONSTRAINT sites_geofence_radius_chk
  CHECK (geofence_radius_m IS NULL OR geofence_radius_m BETWEEN 50 AND 1000);
ALTER TABLE public.sites DROP CONSTRAINT IF EXISTS sites_location_source_chk;
ALTER TABLE public.sites ADD CONSTRAINT sites_location_source_chk
  CHECK (location_source IS NULL OR location_source IN ('technician', 'manual', 'geocoded'));

ALTER TABLE public.time_entries ADD COLUMN IF NOT EXISTS site_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sites_location_set_by_fkey'
                    AND conrelid = 'public.sites'::regclass) THEN
    ALTER TABLE public.sites ADD CONSTRAINT sites_location_set_by_fkey
      FOREIGN KEY (location_set_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'time_entries_site_id_fkey'
                    AND conrelid = 'public.time_entries'::regclass) THEN
    ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_site_id_fkey
      FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE public.sites VALIDATE CONSTRAINT sites_location_set_by_fkey;
ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_site_id_fkey;

CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_site_id_idx
  ON public.time_entries (site_id) WHERE site_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.time_entries'::regclass
     AND c.relname = 'time_entries_site_id_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'time_entries site index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;

RESET lock_timeout;
