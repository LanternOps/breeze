-- 2026-11-08-120100-backup-storage-write-sessions.sql
--
-- Write-scoped storage sessions for brokered backup writes.
--
-- 1. backup_storage_sessions gains the write scope. A write session is bound
--    to its backup job (job_id — a scheduled backup has no command row), to a
--    snapshot id reservation (reservation_snapshot_id) and to that
--    reservation's write generation. url_horizon_at is the latest expiry of
--    any object URL the session has issued (monotonic). conditional_writes
--    records whether this session's single-object uploads carried a
--    create-only condition. resumed_at / read_only record the one permitted
--    resume of a journaled snapshot id. A write session never has a command
--    or an internal snapshot reference; a read session never has a job or a
--    reservation (backup_storage_sessions_shape_chk).
--
-- 2. backup_storage_session_uploads: one row per multipart upload created
--    through a write session, so an abort can be made durable after the
--    session, the job or the process has gone away.
--    TENANCY: shape 1 (direct org_id) with device_id, so the device-move
--    trigger restamps it with the session it belongs to. FKs are CASCADE.
--
-- 3. Parent-org guards on both tables: the job, device, reservation and
--    session a row names must be in the row's organization. Only references
--    the statement sets or changes are checked, so an org_id restamp (device
--    move, org merge) passes through.
--
-- 4. Job-end revocation: when a backup job leaves pending/running, its write
--    sessions are revoked. Uploads are left to the cleanup job, which aborts
--    them against storage.
--
-- 5. Sealing at publication: breeze_backup_snapshot_reserve_id (first defined
--    in 2026-11-08-120000) now seals a reserved id when its snapshot row is
--    inserted: every write session of the reservation is revoked, and the
--    reservation becomes 'published' at once when no unconditional upload URL
--    can still be used and no multipart completion is in flight, otherwise
--    'sealing' until sealed_until (the latest such URL expiry plus clock
--    skew) has passed and the cleanup job has settled every in-flight
--    completion, after which it publishes it.
--
-- DDL only: no rows written, so no breeze.scope election. Idempotent.

ALTER TABLE backup_storage_sessions ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE backup_storage_sessions ALTER COLUMN snapshot_id DROP NOT NULL;
ALTER TABLE backup_storage_sessions
  ADD COLUMN IF NOT EXISTS job_id uuid NULL REFERENCES backup_jobs (id) ON DELETE CASCADE;
ALTER TABLE backup_storage_sessions
  ADD COLUMN IF NOT EXISTS reservation_snapshot_id text NULL
    REFERENCES backup_snapshot_id_reservations (snapshot_id) ON DELETE CASCADE;
ALTER TABLE backup_storage_sessions ADD COLUMN IF NOT EXISTS reservation_generation integer NULL;
ALTER TABLE backup_storage_sessions ADD COLUMN IF NOT EXISTS url_horizon_at timestamptz NULL;
ALTER TABLE backup_storage_sessions ADD COLUMN IF NOT EXISTS conditional_writes boolean NOT NULL DEFAULT false;
ALTER TABLE backup_storage_sessions ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false;
ALTER TABLE backup_storage_sessions ADD COLUMN IF NOT EXISTS resumed_at timestamptz NULL;

ALTER TABLE backup_storage_sessions DROP CONSTRAINT IF EXISTS backup_storage_sessions_scope_chk;
ALTER TABLE backup_storage_sessions ADD CONSTRAINT backup_storage_sessions_scope_chk
  CHECK (scope IN ('snapshot_read', 'snapshot_write'));
ALTER TABLE backup_storage_sessions DROP CONSTRAINT IF EXISTS backup_storage_sessions_shape_chk;
ALTER TABLE backup_storage_sessions ADD CONSTRAINT backup_storage_sessions_shape_chk CHECK (
  (scope = 'snapshot_read'
    AND command_id IS NOT NULL AND snapshot_id IS NOT NULL
    AND job_id IS NULL AND reservation_snapshot_id IS NULL AND reservation_generation IS NULL
    AND read_only = false AND resumed_at IS NULL)
  OR
  (scope = 'snapshot_write'
    AND job_id IS NOT NULL AND snapshot_id IS NULL
    AND reservation_snapshot_id IS NOT NULL AND reservation_generation IS NOT NULL AND reservation_generation >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_storage_sessions_job_generation_uq
  ON backup_storage_sessions (job_id, generation) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS backup_storage_sessions_reservation_idx
  ON backup_storage_sessions (reservation_snapshot_id);

CREATE TABLE IF NOT EXISTS backup_storage_session_uploads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations (id),
  device_id               uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  session_id              uuid NOT NULL REFERENCES backup_storage_sessions (id) ON DELETE CASCADE,
  reservation_snapshot_id text NOT NULL,
  reservation_generation  integer NOT NULL,
  object_key              text NOT NULL,
  upload_id               text NULL,
  state                   text NOT NULL DEFAULT 'creating',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_storage_session_uploads_state_chk
    CHECK (state IN ('creating', 'open', 'completing', 'completed', 'aborted')),
  CONSTRAINT backup_storage_session_uploads_upload_id_chk
    CHECK (state IN ('creating', 'aborted') OR upload_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_storage_session_uploads_key_upload_uq
  ON backup_storage_session_uploads (object_key, upload_id) WHERE upload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS backup_storage_session_uploads_org_idx
  ON backup_storage_session_uploads (org_id);
CREATE INDEX IF NOT EXISTS backup_storage_session_uploads_device_idx
  ON backup_storage_session_uploads (device_id);
CREATE INDEX IF NOT EXISTS backup_storage_session_uploads_session_idx
  ON backup_storage_session_uploads (session_id);
CREATE INDEX IF NOT EXISTS backup_storage_session_uploads_reservation_idx
  ON backup_storage_session_uploads (reservation_snapshot_id);
CREATE INDEX IF NOT EXISTS backup_storage_session_uploads_open_idx
  ON backup_storage_session_uploads (state)
  WHERE state IN ('creating', 'open', 'completing');

ALTER TABLE backup_storage_session_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_storage_session_uploads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_storage_session_uploads;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_storage_session_uploads;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_storage_session_uploads;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_storage_session_uploads;
CREATE POLICY breeze_org_isolation_select ON backup_storage_session_uploads FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_storage_session_uploads FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_storage_session_uploads FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_storage_session_uploads FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_storage_session_uploads TO breeze_app;

-- Parent-org guard: storage sessions.
CREATE OR REPLACE FUNCTION public.breeze_backup_storage_session_parent_org_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = NEW.device_id AND d.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'storage session device is not in the session organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.job_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.job_id IS DISTINCT FROM OLD.job_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.backup_jobs j
       WHERE j.id = NEW.job_id AND j.org_id = NEW.org_id AND j.device_id = NEW.device_id
    ) THEN
      RAISE EXCEPTION 'storage session job is not a job of the session device and organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.reservation_snapshot_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.reservation_snapshot_id IS DISTINCT FROM OLD.reservation_snapshot_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.backup_snapshot_id_reservations r
       WHERE r.snapshot_id = NEW.reservation_snapshot_id AND r.org_id = NEW.org_id
    ) THEN
      RAISE EXCEPTION 'storage session reservation is not in the session organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_storage_sessions_parent_org_guard ON backup_storage_sessions;
CREATE TRIGGER backup_storage_sessions_parent_org_guard
  BEFORE INSERT OR UPDATE ON backup_storage_sessions
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_storage_session_parent_org_guard();

-- Parent-org guard: multipart upload rows.
CREATE OR REPLACE FUNCTION public.breeze_backup_storage_upload_parent_org_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.backup_storage_sessions s
       WHERE s.id = NEW.session_id AND s.org_id = NEW.org_id AND s.device_id = NEW.device_id
         AND s.scope = 'snapshot_write'
    ) THEN
      RAISE EXCEPTION 'upload session is not a write session of the upload device and organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- A new upload belongs to the reservation and write generation its session
  -- currently holds.
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM public.backup_storage_sessions s
     WHERE s.id = NEW.session_id
       AND s.reservation_snapshot_id = NEW.reservation_snapshot_id
       AND s.reservation_generation = NEW.reservation_generation
  ) THEN
    RAISE EXCEPTION 'upload is not for the reservation its session holds'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_storage_session_uploads_parent_org_guard ON backup_storage_session_uploads;
CREATE TRIGGER backup_storage_session_uploads_parent_org_guard
  BEFORE INSERT OR UPDATE ON backup_storage_session_uploads
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_storage_upload_parent_org_guard();

-- Job-end revocation. Runs as the invoking role; a caller that cannot see the
-- rows updates none, and the endpoints independently refuse any write session
-- whose job is no longer pending/running.
CREATE OR REPLACE FUNCTION public.breeze_revoke_backup_write_sessions_on_job_end()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.backup_storage_sessions
     SET revoked_at = now(),
         revoked_reason = 'job_' || NEW.status::text
   WHERE job_id = NEW.id
     AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS backup_jobs_revoke_write_sessions ON backup_jobs;
CREATE TRIGGER backup_jobs_revoke_write_sessions
  AFTER UPDATE OF status ON backup_jobs
  FOR EACH ROW
  WHEN (NEW.status::text NOT IN ('pending', 'running') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.breeze_revoke_backup_write_sessions_on_job_end();

-- Reserve-or-match, now sealing a reserved id at publication.
CREATE OR REPLACE FUNCTION public.breeze_backup_snapshot_reserve_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  r public.backup_snapshot_id_reservations%ROWTYPE;
  _horizon timestamptz;
  _sealed timestamptz;
  _completing boolean;
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
    IF r.state = 'reserved' THEN
      UPDATE public.backup_storage_sessions
         SET revoked_at = now(), revoked_reason = 'sealed'
       WHERE reservation_snapshot_id = NEW.snapshot_id
         AND revoked_at IS NULL;
      -- Only an upload URL issued WITHOUT a create-only condition can still
      -- replace an object that now belongs to the published snapshot.
      SELECT max(s.url_horizon_at) INTO _horizon
        FROM public.backup_storage_sessions s
       WHERE s.reservation_snapshot_id = NEW.snapshot_id
         AND s.conditional_writes = false;
      _sealed := CASE WHEN _horizon IS NULL THEN now() ELSE GREATEST(_horizon + interval '60 seconds', now()) END;
      -- A multipart completion still in flight may yet create or replace an
      -- object: the snapshot stays sealing until the cleanup job has settled
      -- every such upload.
      SELECT EXISTS (
        SELECT 1 FROM public.backup_storage_session_uploads u
         WHERE u.reservation_snapshot_id = NEW.snapshot_id AND u.state = 'completing'
      ) INTO _completing;
      UPDATE public.backup_snapshot_id_reservations
         SET published_snapshot_db_id = NEW.id,
             sealed_until = _sealed,
             state = CASE WHEN _sealed <= now() AND NOT _completing THEN 'published' ELSE 'sealing' END,
             updated_at = now()
       WHERE snapshot_id = NEW.snapshot_id;
    ELSE
      UPDATE public.backup_snapshot_id_reservations
         SET published_snapshot_db_id = NEW.id,
             updated_at = now()
       WHERE snapshot_id = NEW.snapshot_id;
    END IF;
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
