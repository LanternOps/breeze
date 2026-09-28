-- 2026-11-08-160000-backup-snapshot-reservation-current-job.sql
--
-- Two changes to breeze_backup_snapshot_reserve_id (the backup_snapshots
-- insert trigger, last defined in 2026-11-08-120100-backup-storage-write-sessions.sql):
--
-- 1. Current job. A server-issued snapshot id can now be taken over by a
--    later backup job of the same device, configuration, destination and
--    dispatched base, which continues an unfinished upload
--    (services/backupStorageWriteSessions.ts, decideResumeTarget). From then
--    on only that job may publish the id: a snapshot row for a server-issued
--    id is accepted only from the job currently recorded on its reservation
--    (current_job_id), in every state. The earlier job's late result, or a
--    storage reconcile attributing the prefix to it, is refused like any
--    other foreign claim (a unique violation on the reservation key). The
--    same-job adoption window for an abandoned id is unchanged (108 hours
--    after abandonment, for the job recorded on it). Reservations recorded
--    for older helpers' jobs (source legacy_job) and ids first seen through a
--    snapshot row keep the previous rules.
--
-- 2. Transfer margin. Storage checks a presigned URL's expiry only when a
--    request starts, so an upload begun just before expiry may still land
--    afterwards. Sealing now waits out the latest URL expiry of ANY session
--    of the reservation plus a 15-minute transfer margin
--    (STORAGE_WRITE_TRANSFER_MARGIN_MS) plus 60 seconds of clock skew,
--    instead of the expiry plus clock skew alone. Reservations already
--    sealing are extended to the same bound (counted with RAISE WARNING).
--
-- Idempotent: CREATE OR REPLACE, and the extension below is a no-op on
-- re-run (GREATEST of an already-extended bound). No inner BEGIN/COMMIT.

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
  _adoptable boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id THEN
    RETURN NULL;
  END IF;
  SELECT * INTO r FROM public.backup_snapshot_id_reservations WHERE snapshot_id = NEW.snapshot_id FOR UPDATE;
  IF FOUND THEN
    _adoptable := r.state = 'abandoned'
      AND r.current_job_id IS NOT NULL
      AND r.current_job_id = NEW.job_id
      AND r.updated_at > now() - interval '108 hours';
    IF r.org_id <> NEW.org_id
       OR (r.device_id IS NOT NULL AND r.device_id <> NEW.device_id)
       OR (r.state NOT IN ('reserved', 'sealing', 'published') AND NOT _adoptable)
       -- A server-issued id is published only by the job currently holding it.
       OR (r.source = 'server_minted'
           AND (r.current_job_id IS NULL OR NEW.job_id IS NULL OR r.current_job_id <> NEW.job_id)) THEN
      RAISE EXCEPTION 'snapshot id % belongs to another backup', NEW.snapshot_id
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'backup_snapshot_id_reservations_pkey';
    END IF;
    IF r.state = 'reserved' OR _adoptable THEN
      UPDATE public.backup_storage_sessions
         SET revoked_at = now(), revoked_reason = 'sealed'
       WHERE reservation_snapshot_id = NEW.snapshot_id
         AND revoked_at IS NULL;
      -- Every URL issued for the id, create-only or not, is waited out, plus
      -- the time an upload started just before its URL expired may still take.
      SELECT max(s.url_horizon_at) INTO _horizon
        FROM public.backup_storage_sessions s
       WHERE s.reservation_snapshot_id = NEW.snapshot_id;
      _sealed := CASE
        WHEN _horizon IS NULL THEN now()
        ELSE GREATEST(_horizon + interval '15 minutes' + interval '60 seconds', now())
      END;
      -- A multipart completion or a delete still in flight may yet change
      -- an object: the snapshot stays sealing until the cleanup job has
      -- settled every such operation.
      SELECT EXISTS (
        SELECT 1 FROM public.backup_storage_session_uploads u
         WHERE u.reservation_snapshot_id = NEW.snapshot_id AND u.state = 'completing'
      ) OR EXISTS (
        SELECT 1 FROM public.backup_storage_sessions s
         WHERE s.reservation_snapshot_id = NEW.snapshot_id AND s.deleting_since IS NOT NULL
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

-- Reservations already sealing wait out the same bound.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE backup_snapshot_id_reservations r
     SET sealed_until = h.bound
    FROM (
      SELECT s.reservation_snapshot_id AS snapshot_id,
             max(s.url_horizon_at) + interval '15 minutes' + interval '60 seconds' AS bound
        FROM backup_storage_sessions s
       WHERE s.reservation_snapshot_id IS NOT NULL AND s.url_horizon_at IS NOT NULL
       GROUP BY s.reservation_snapshot_id
    ) h
   WHERE r.snapshot_id = h.snapshot_id
     AND r.state = 'sealing'
     AND (r.sealed_until IS NULL OR r.sealed_until < h.bound);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backup snapshot sealing: extended % sealing reservation(s) by the transfer margin', n;
END $$;
