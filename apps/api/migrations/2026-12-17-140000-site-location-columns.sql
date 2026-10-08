-- @no-transaction
-- #4186 W1: site pin columns + time-entry site link (location-aware time
-- suggestions). The only coordinate stored server-side is a deliberately
-- pinned SITE location; no technician position is ever written. Every column
-- is nullable with no default: no backfill, no table rewrite, existing rows
-- untouched. No UPDATE/INSERT here, so no breeze.scope elevation is needed.
--
-- Locking (outside a transaction, each statement sent on its own):
--   * ADD COLUMN (nullable, no default) is catalog-only.
--   * Both FKs are added NOT VALID (catalog only; still checks new rows and
--     still fires ON DELETE SET NULL) and then VALIDATEd in a separate
--     statement, which takes only SHARE UPDATE EXCLUSIVE on the child so
--     writes continue during the scan. Adding an FK takes SHARE ROW
--     EXCLUSIVE on the parent (users / sites); lock_timeout bounds the wait
--     so a queued lock request cannot stall heartbeats or logins. On
--     failure autoMigrate aborts boot and the file re-runs cleanly.
--   * The partial index is built CONCURRENTLY (permitted here), so time_entries
--     keeps taking writes.
-- Idempotent: every DDL statement is IF NOT EXISTS / DROP IF EXISTS + re-add.
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

ALTER TABLE public.sites
  DROP CONSTRAINT IF EXISTS sites_location_set_by_fkey,
  ADD CONSTRAINT sites_location_set_by_fkey
    FOREIGN KEY (location_set_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_site_id_fkey,
  ADD CONSTRAINT time_entries_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.sites VALIDATE CONSTRAINT sites_location_set_by_fkey;
ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_site_id_fkey;

CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_site_id_idx
  ON public.time_entries (site_id) WHERE site_id IS NOT NULL;

RESET lock_timeout;
