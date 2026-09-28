-- 2026-11-08-120000-backup-snapshot-id-reservations.sql
--
-- One owner per backup snapshot id, across every organization, storage
-- destination and endpoint spelling.
--
-- 1. backup_snapshot_id_reservations
--    One row per snapshot id, keyed by the id ALONE: two destinations that are
--    the same physical bucket under different endpoint spellings, and buckets
--    shared by several organizations, still resolve to one owner. A row is
--    created when the server issues an id for a brokered backup write, and
--    for every backup_snapshots row inserted by any writer (agent result,
--    older helper, reconcile) through the AFTER INSERT trigger at the end of
--    this file, which either matches the existing owner or refuses the
--    insert with a unique violation.
--
--    TENANCY: shape 1 (direct org_id), with device_id so the device-move
--    trigger (breeze_cascade_device_org_id) restamps it. Every FK is
--    CASCADE or SET NULL, and no composite FK names org_id, so the org-merge
--    deferral contract does not apply. A parent-org guard refuses a row whose
--    device, job, published snapshot or configuration belongs to another
--    organization; it runs as the invoking role, so a parent that RLS hides
--    is also a refusal. It checks only the references an INSERT or UPDATE
--    sets or changes, so the device-move and org-merge restamps of org_id
--    pass through it.
--
-- 2. backup_snapshot_id_tombstones
--    Ids that may never be issued or accepted again: every deleted
--    reservation (device deletion, organization erasure, storage reclaim) and
--    ids that were already ambiguous when this table was created. Columns are
--    the id, a reason and a timestamp only; there is no organization, device
--    or configuration reference, so the table is not tenant-scoped and is
--    listed as intentionally unscoped in the RLS coverage contract. Access is
--    system context only: forced RLS with a single system-scope policy.
--    breeze_app holds SELECT and INSERT only (no UPDATE or DELETE). The two
--    trigger functions that consult or extend it elevate breeze.scope inside
--    their own body and restore it before their single RETURN.
--
-- 3. Backfill (system scope):
--    a. ids carried by more than one backup_snapshots row are tombstoned and
--       get no reservation (the rows stay readable);
--    b. every other snapshot row gets a published reservation;
--    c. in-flight backup jobs that already recorded an id get a reserved one;
--    d. retired ids with no remaining snapshot row are tombstoned.
--    Each step reports its row count with RAISE WARNING.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS, and
-- every backfill insert is ON CONFLICT DO NOTHING. No inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS backup_snapshot_id_tombstones (
  snapshot_id text PRIMARY KEY,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_snapshot_id_tombstones_reason_chk
    CHECK (reason IN ('reservation_deleted', 'retired', 'legacy_duplicate', 'abandoned_reclaimed'))
);

ALTER TABLE backup_snapshot_id_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_id_tombstones FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backup_snapshot_id_tombstones_system_only ON backup_snapshot_id_tombstones;
CREATE POLICY backup_snapshot_id_tombstones_system_only
  ON backup_snapshot_id_tombstones
  FOR ALL
  USING      (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
REVOKE UPDATE, DELETE, TRUNCATE ON backup_snapshot_id_tombstones FROM breeze_app;
GRANT SELECT, INSERT ON backup_snapshot_id_tombstones TO breeze_app;

CREATE TABLE IF NOT EXISTS backup_snapshot_id_reservations (
  snapshot_id              text PRIMARY KEY,
  org_id                   uuid NOT NULL REFERENCES organizations (id),
  device_id                uuid NULL REFERENCES devices (id) ON DELETE CASCADE,
  config_id                uuid NULL REFERENCES backup_configs (id) ON DELETE SET NULL,
  storage_identity         text NULL,
  source                   text NOT NULL,
  state                    text NOT NULL,
  current_job_id           uuid NULL REFERENCES backup_jobs (id) ON DELETE SET NULL,
  write_generation         integer NOT NULL DEFAULT 1,
  sealed_until             timestamptz NULL,
  published_snapshot_db_id uuid NULL REFERENCES backup_snapshots (id) ON DELETE SET NULL,
  uploads_swept_at         timestamptz NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_snapshot_id_reservations_source_chk
    CHECK (source IN ('server_minted', 'legacy_published', 'legacy_job', 'reconcile')),
  CONSTRAINT backup_snapshot_id_reservations_state_chk
    CHECK (state IN ('reserved', 'sealing', 'published', 'retired', 'abandoned')),
  CONSTRAINT backup_snapshot_id_reservations_generation_chk CHECK (write_generation >= 1)
);

CREATE INDEX IF NOT EXISTS backup_snapshot_id_reservations_org_idx
  ON backup_snapshot_id_reservations (org_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_id_reservations_device_idx
  ON backup_snapshot_id_reservations (device_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_id_reservations_config_idx
  ON backup_snapshot_id_reservations (config_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_id_reservations_job_idx
  ON backup_snapshot_id_reservations (current_job_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_id_reservations_published_idx
  ON backup_snapshot_id_reservations (published_snapshot_db_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_id_reservations_active_idx
  ON backup_snapshot_id_reservations (state)
  WHERE state IN ('reserved', 'sealing', 'abandoned');

ALTER TABLE backup_snapshot_id_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_id_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshot_id_reservations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshot_id_reservations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshot_id_reservations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshot_id_reservations;
CREATE POLICY breeze_org_isolation_select ON backup_snapshot_id_reservations FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_snapshot_id_reservations FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_snapshot_id_reservations FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_snapshot_id_reservations FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_snapshot_id_reservations TO breeze_app;

-- (1) A tombstoned id can never be reserved again.
CREATE OR REPLACE FUNCTION public.breeze_backup_reservation_not_tombstoned()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _tombstoned boolean;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT EXISTS (
    SELECT 1 FROM public.backup_snapshot_id_tombstones t WHERE t.snapshot_id = NEW.snapshot_id
  ) INTO _tombstoned;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _tombstoned THEN
    RAISE EXCEPTION 'snapshot id % is no longer available', NEW.snapshot_id
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'backup_snapshot_id_reservations_pkey';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_snapshot_id_reservations_not_tombstoned ON backup_snapshot_id_reservations;
CREATE TRIGGER backup_snapshot_id_reservations_not_tombstoned
  BEFORE INSERT ON backup_snapshot_id_reservations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_reservation_not_tombstoned();

-- (2) Deleting a reservation leaves a tombstone: ownership outlives the row.
--     An earlier, more specific tombstone (retired, abandoned_reclaimed) wins.
CREATE OR REPLACE FUNCTION public.breeze_backup_reservation_tombstone_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO public.backup_snapshot_id_tombstones (snapshot_id, reason)
  VALUES (OLD.snapshot_id, 'reservation_deleted')
  ON CONFLICT (snapshot_id) DO NOTHING;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS backup_snapshot_id_reservations_tombstone ON backup_snapshot_id_reservations;
CREATE TRIGGER backup_snapshot_id_reservations_tombstone
  AFTER DELETE ON backup_snapshot_id_reservations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_reservation_tombstone_on_delete();

-- (3) Parent-org guard. Checks only the references this statement sets or
--     changes; a restamp of org_id alone (device move, org merge) is exempt.
CREATE OR REPLACE FUNCTION public.breeze_backup_reservation_parent_org_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.device_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.device_id IS DISTINCT FROM OLD.device_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = NEW.device_id AND d.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'snapshot reservation device is not in the reservation organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.current_job_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.current_job_id IS DISTINCT FROM OLD.current_job_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.backup_jobs j WHERE j.id = NEW.current_job_id AND j.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'snapshot reservation job is not in the reservation organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.published_snapshot_db_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.published_snapshot_db_id IS DISTINCT FROM OLD.published_snapshot_db_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.backup_snapshots s WHERE s.id = NEW.published_snapshot_db_id AND s.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'snapshot reservation snapshot is not in the reservation organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.config_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.config_id IS DISTINCT FROM OLD.config_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.backup_configs c WHERE c.id = NEW.config_id AND c.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'snapshot reservation configuration is not in the reservation organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_snapshot_id_reservations_parent_org_guard ON backup_snapshot_id_reservations;
CREATE TRIGGER backup_snapshot_id_reservations_parent_org_guard
  BEFORE INSERT OR UPDATE ON backup_snapshot_id_reservations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_reservation_parent_org_guard();

-- (4) Every backup_snapshots row owns its id. Runs as the invoking role: an id
--     owned by another organization is invisible here, and the INSERT below
--     then fails on the primary key (a unique violation), which refuses the
--     snapshot row. Device and configuration are recorded only when they are
--     in the snapshot's organization, so a snapshot row is never refused for
--     an informational reference. Sealing of a reserved id is added by
--     2026-11-08-120100-backup-storage-write-sessions.sql.
CREATE OR REPLACE FUNCTION public.breeze_backup_snapshot_reserve_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  r public.backup_snapshot_id_reservations%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id THEN
    RETURN NULL;
  END IF;
  SELECT * INTO r FROM public.backup_snapshot_id_reservations WHERE snapshot_id = NEW.snapshot_id FOR UPDATE;
  IF FOUND THEN
    IF r.org_id <> NEW.org_id
       OR (r.device_id IS NOT NULL AND r.device_id <> NEW.device_id)
       OR r.state NOT IN ('reserved', 'sealing', 'published') THEN
      RAISE EXCEPTION 'snapshot id % belongs to another backup', NEW.snapshot_id
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'backup_snapshot_id_reservations_pkey';
    END IF;
    UPDATE public.backup_snapshot_id_reservations
       SET published_snapshot_db_id = NEW.id,
           state = CASE WHEN r.state = 'reserved' THEN 'sealing' ELSE r.state END,
           updated_at = now()
     WHERE snapshot_id = NEW.snapshot_id;
  ELSE
    INSERT INTO public.backup_snapshot_id_reservations
      (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, published_snapshot_db_id)
    VALUES (
      NEW.snapshot_id,
      NEW.org_id,
      (SELECT d.id FROM public.devices d WHERE d.id = NEW.device_id AND d.org_id = NEW.org_id),
      (SELECT c.id FROM public.backup_configs c WHERE c.id = NEW.config_id AND c.org_id = NEW.org_id),
      NEW.storage_identity,
      'legacy_published',
      'published',
      NEW.id
    );
  END IF;
  RETURN NULL;
END;
$$;

-- ── Backfill ────────────────────────────────────────────────────────────────
SELECT set_config('breeze.scope', 'system', true);

-- a. Ambiguous ids: carried by more than one snapshot row. Tombstoned so they
--    can never be reserved; the existing rows stay readable.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO backup_snapshot_id_tombstones (snapshot_id, reason)
  SELECT s.snapshot_id, 'legacy_duplicate'
    FROM backup_snapshots s
   WHERE NOT EXISTS (SELECT 1 FROM backup_snapshot_id_reservations r WHERE r.snapshot_id = s.snapshot_id)
   GROUP BY s.snapshot_id
  HAVING count(*) > 1
  ON CONFLICT (snapshot_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backup snapshot id backfill: tombstoned % id(s) carried by more than one snapshot row', n;
END $$;

-- b. Every other snapshot row owns its id.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO backup_snapshot_id_reservations
    (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, published_snapshot_db_id)
  SELECT s.snapshot_id,
         s.org_id,
         (SELECT d.id FROM devices d WHERE d.id = s.device_id AND d.org_id = s.org_id),
         (SELECT c.id FROM backup_configs c WHERE c.id = s.config_id AND c.org_id = s.org_id),
         s.storage_identity,
         'legacy_published',
         'published',
         s.id
    FROM backup_snapshots s
   WHERE NOT EXISTS (SELECT 1 FROM backup_snapshot_id_tombstones t WHERE t.snapshot_id = s.snapshot_id)
  ON CONFLICT (snapshot_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backup snapshot id backfill: reserved % published snapshot id(s)', n;
END $$;

-- c. In-flight jobs that already recorded an id (the newest job wins when a
--    resumed run recorded the same id on several jobs).
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO backup_snapshot_id_reservations
    (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, current_job_id)
  SELECT DISTINCT ON (j.snapshot_id)
         j.snapshot_id,
         j.org_id,
         (SELECT d.id FROM devices d WHERE d.id = j.device_id AND d.org_id = j.org_id),
         (SELECT c.id FROM backup_configs c WHERE c.id = j.config_id AND c.org_id = j.org_id),
         j.storage_identity,
         'legacy_job',
         'reserved',
         j.id
    FROM backup_jobs j
   WHERE j.status IN ('pending', 'running')
     AND j.snapshot_id IS NOT NULL
     AND j.snapshot_id <> ''
     AND NOT EXISTS (SELECT 1 FROM backup_snapshot_id_reservations r WHERE r.snapshot_id = j.snapshot_id)
     AND NOT EXISTS (SELECT 1 FROM backup_snapshot_id_tombstones t WHERE t.snapshot_id = j.snapshot_id)
   ORDER BY j.snapshot_id, j.created_at DESC, j.id DESC
  ON CONFLICT (snapshot_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backup snapshot id backfill: reserved % in-flight job snapshot id(s)', n;
END $$;

-- d. Retired ids with no remaining snapshot row and no owner.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO backup_snapshot_id_tombstones (snapshot_id, reason)
  SELECT DISTINCT rt.snapshot_id, 'retired'
    FROM backup_snapshot_retirements rt
   WHERE NOT EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.snapshot_id = rt.snapshot_id)
     AND NOT EXISTS (SELECT 1 FROM backup_snapshot_id_reservations r WHERE r.snapshot_id = rt.snapshot_id)
  ON CONFLICT (snapshot_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backup snapshot id backfill: tombstoned % retired snapshot id(s)', n;
END $$;

-- The insert trigger is created AFTER the backfill so the backfill's own
-- reads see a stable set.
DROP TRIGGER IF EXISTS backup_snapshots_reserve_id ON backup_snapshots;
CREATE TRIGGER backup_snapshots_reserve_id
  AFTER INSERT OR UPDATE OF snapshot_id ON backup_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_snapshot_reserve_id();
