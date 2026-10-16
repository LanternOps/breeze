-- 2026-12-28-110000-backup-key-root.sql
--
-- #7081 / #8731: per-snapshot key root for backup destinations with a key
-- prefix.
--
-- A snapshot's objects live under a key root recorded on the row:
--   key_layout = 'legacy_flat',   key_prefix = NULL  -> snapshots/<id>/...
--   key_layout = 'prefixed_flat', key_prefix = P     -> P/snapshots/<id>/...
-- (services/backupKeyLayout.ts). The root is fixed on the snapshot-id
-- reservation when a write session is minted, copied to the snapshot row at
-- publish and to the retirement tombstone at retirement, and never changes.
--
-- This migration:
--   1. adds key_layout / key_prefix to backup_snapshot_id_reservations and
--      backup_snapshot_retirements, and key_prefix to backup_snapshots
--      (which already has key_layout);
--   2. widens backup_snapshots_key_layout_chk to accept 'prefixed_flat', adds
--      the same layout CHECK to the two other tables, and a pair CHECK on all
--      three (prefix present exactly for 'prefixed_flat'; no empty value, no
--      leading/trailing or doubled slash; at most 256 characters);
--   3. makes (key_layout, key_prefix) immutable on all three tables
--      (BEFORE UPDATE trigger breeze_backup_key_root_immutable);
--   4. extends breeze_backup_snapshot_reserve_id (the backup_snapshots AFTER
--      INSERT/UPDATE OF snapshot_id trigger, last defined in
--      2026-11-08-160000-backup-snapshot-reservation-current-job.sql) so a
--      snapshot row must carry its reservation's root, and a reservation it
--      synthesizes copies the row's root;
--   5. adds key_layout / key_prefix to backup_erasure_targets and records the
--      source row's root when breeze_backup_erasure_fence_on_delete (last
--      defined in 2026-12-11-100000-backup-erasure-fences.sql) fences a
--      snapshot prefix.
--
-- DDL only: every existing row stays ('legacy_flat', NULL) through the column
-- defaults, and no row is written here, so no system-scope election is
-- needed. Nothing writes 'prefixed_flat' yet.
--
-- Rollback floor: once a later release writes 'prefixed_flat', an API older
-- than the one shipping this migration must not run against the database (it
-- would refuse those rows at best; see services/backupKeyLayout.ts).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD,
-- CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE. No inner
-- BEGIN/COMMIT. autoMigrate runs this file in one transaction, so the
-- ACCESS EXCLUSIVE locks taken by the CHECK changes are held through their
-- validation scans; a NOT VALID / VALIDATE split would buy nothing here.

-- 1. Columns -----------------------------------------------------------------

ALTER TABLE backup_snapshot_id_reservations
  ADD COLUMN IF NOT EXISTS key_layout text NOT NULL DEFAULT 'legacy_flat';
ALTER TABLE backup_snapshot_id_reservations ADD COLUMN IF NOT EXISTS key_prefix text;
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS key_prefix text;
ALTER TABLE backup_snapshot_retirements
  ADD COLUMN IF NOT EXISTS key_layout text NOT NULL DEFAULT 'legacy_flat';
ALTER TABLE backup_snapshot_retirements ADD COLUMN IF NOT EXISTS key_prefix text;

-- 2. CHECKs ------------------------------------------------------------------

-- 'device_scoped' stays accepted: it is the value readers must refuse
-- (backupKeyLayout.ts), existing snapshot rows may carry it, and a snapshot
-- row's layout is copied to the reservation the reserve-id trigger
-- synthesizes for it, so all three tables accept the same set.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backup_snapshots', 'backup_snapshot_id_reservations', 'backup_snapshot_retirements'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_key_layout_chk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (key_layout IN (''legacy_flat'', ''prefixed_flat'', ''device_scoped''))',
      t, t || '_key_layout_chk');
  END LOOP;
END $$;

-- The prefix is present exactly for 'prefixed_flat'. The full prefix grammar
-- (S3 safe characters, no '.'/'..' segment, no 'snapshots' segment) is
-- enforced by normalizeBackupDestinationPrefix in the API, which also refuses
-- any stored value that is not already in normalized form; the database pins
-- the structural part.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backup_snapshots', 'backup_snapshot_id_reservations', 'backup_snapshot_retirements'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_key_prefix_chk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ('
      || '((key_layout = ''prefixed_flat'') = (key_prefix IS NOT NULL))'
      || ' AND (key_prefix IS NULL OR (key_prefix <> '''' AND key_prefix !~ ''(^/|/$|//)'' AND length(key_prefix) <= 256))'
      || ')', t, t || '_key_prefix_chk');
  END LOOP;
END $$;

-- 3. Root immutability -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.breeze_backup_key_root_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.key_layout, NEW.key_prefix) IS DISTINCT FROM (OLD.key_layout, OLD.key_prefix) THEN
    RAISE EXCEPTION '%: key_layout/key_prefix are immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_snapshots_key_root_immutable ON backup_snapshots;
CREATE TRIGGER backup_snapshots_key_root_immutable
  BEFORE UPDATE OF key_layout, key_prefix ON backup_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_key_root_immutable();

DROP TRIGGER IF EXISTS backup_snapshot_id_reservations_key_root_immutable ON backup_snapshot_id_reservations;
CREATE TRIGGER backup_snapshot_id_reservations_key_root_immutable
  BEFORE UPDATE OF key_layout, key_prefix ON backup_snapshot_id_reservations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_key_root_immutable();

DROP TRIGGER IF EXISTS backup_snapshot_retirements_key_root_immutable ON backup_snapshot_retirements;
CREATE TRIGGER backup_snapshot_retirements_key_root_immutable
  BEFORE UPDATE OF key_layout, key_prefix ON backup_snapshot_retirements
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_key_root_immutable();

-- 4. Reservation <-> snapshot root equality ----------------------------------
--
-- Copied verbatim from 2026-11-08-160000-backup-snapshot-reservation-current-job.sql
-- with two additions (marked #7081): a snapshot row whose root differs from
-- its reservation's is refused like any other foreign claim, and a
-- synthesized reservation copies the row's root. This is an AFTER trigger and
-- cannot rewrite NEW: publish sends the reservation's root, and this proves it.

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
           AND (r.current_job_id IS NULL OR NEW.job_id IS NULL OR r.current_job_id <> NEW.job_id))
       -- #7081: the snapshot row records the key root its id was reserved with.
       OR (r.key_layout, r.key_prefix) IS DISTINCT FROM (NEW.key_layout, NEW.key_prefix) THEN
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
      (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, published_snapshot_db_id,
       key_layout, key_prefix)
    VALUES (
      NEW.snapshot_id,
      NEW.org_id,
      (SELECT d.id FROM public.devices d WHERE d.id = NEW.device_id AND d.org_id = NEW.org_id),
      (SELECT c.id FROM public.backup_configs c WHERE c.id = NEW.config_id AND c.org_id = NEW.org_id),
      NEW.storage_identity,
      'legacy_published',
      'published',
      NEW.id,
      -- #7081: the synthesized reservation carries the row's root.
      NEW.key_layout,
      NEW.key_prefix
    );
  END IF;
  RETURN NULL;
END;
$$;

-- 5. Erasure evidence keeps the root -----------------------------------------
--
-- NULL for recovery-media targets and for targets captured before this
-- migration (all of which are legacy_flat: nothing wrote any other root).

ALTER TABLE backup_erasure_targets ADD COLUMN IF NOT EXISTS key_layout text;
ALTER TABLE backup_erasure_targets ADD COLUMN IF NOT EXISTS key_prefix text;

-- Copied verbatim from 2026-12-11-100000-backup-erasure-fences.sql with one
-- addition (marked #7081): a fenced snapshot prefix records the deleted
-- source row's key root.
CREATE OR REPLACE FUNCTION public.breeze_backup_erasure_fence_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _org      text := current_setting('breeze.backup_erasure_org', true);
  _row      jsonb;
  _manifest uuid;
  _identity text;
  _snapshot text;
  _key      text;
  _source   text;
BEGIN
  IF _org IS NULL OR _org = '' OR OLD.org_id::text <> _org THEN
    RETURN OLD;
  END IF;
  _row := to_jsonb(OLD);

  INSERT INTO public.backup_erasure_manifests (subject_org_id, subject_partner_id)
  VALUES (OLD.org_id, (SELECT o.partner_id FROM public.organizations o WHERE o.id = OLD.org_id))
  ON CONFLICT (subject_org_id) DO NOTHING;
  SELECT m.id INTO _manifest FROM public.backup_erasure_manifests m WHERE m.subject_org_id = OLD.org_id;

  IF TG_TABLE_NAME IN ('backup_snapshots', 'backup_snapshot_retirements', 'backup_snapshot_id_reservations') THEN
    _source := CASE TG_TABLE_NAME
      WHEN 'backup_snapshots' THEN 'snapshot'
      WHEN 'backup_snapshot_retirements' THEN 'retirement'
      ELSE 'reservation' END;
    _identity := NULLIF(_row->>'storage_identity', '');
    INSERT INTO public.backup_erasure_targets (
      manifest_id, subject_org_id, kind, source, storage_identity, provider, snapshot_id,
      size_bytes, file_count, snapshot_at, is_immutable, immutable_until, immutability_enforcement,
      key_layout, key_prefix)
    SELECT _manifest, OLD.org_id, 'snapshot_prefix', _source, _identity,
           NULLIF(split_part(COALESCE(_identity, ''), '::', 1), ''),
           _row->>'snapshot_id',
           (_row->>'size')::bigint, (_row->>'file_count')::integer, (_row->>'timestamp')::timestamptz,
           (_row->>'is_immutable')::boolean, (_row->>'immutable_until')::timestamptz,
           _row->>'immutability_enforcement',
           -- #7081: the key root the fenced objects live under.
           _row->>'key_layout', _row->>'key_prefix'
     WHERE NOT EXISTS (
       SELECT 1 FROM public.backup_erasure_targets t
        WHERE t.kind = 'snapshot_prefix' AND t.subject_org_id = OLD.org_id AND t.snapshot_id = _row->>'snapshot_id')
    ON CONFLICT DO NOTHING;
  ELSE
    -- recovery_media_artifacts / recovery_boot_media_artifacts: the bundle or
    -- image plus its checksum/signature sidecars, in the snapshot's destination.
    _source := CASE TG_TABLE_NAME WHEN 'recovery_media_artifacts' THEN 'recovery_media' ELSE 'recovery_boot_media' END;
    SELECT s.storage_identity, s.snapshot_id INTO _identity, _snapshot
      FROM public.backup_snapshots s WHERE s.id = (_row->>'snapshot_id')::uuid;
    FOREACH _key IN ARRAY ARRAY[_row->>'storage_key', _row->>'checksum_storage_key', _row->>'signature_storage_key'] LOOP
      CONTINUE WHEN _key IS NULL OR _key = '';
      INSERT INTO public.backup_erasure_targets (
        manifest_id, subject_org_id, kind, source, storage_identity, provider, snapshot_id, object_key)
      SELECT _manifest, OLD.org_id, 'recovery_media_key', _source, _identity,
             NULLIF(split_part(COALESCE(_identity, ''), '::', 1), ''), _snapshot, _key
       WHERE NOT EXISTS (
         SELECT 1 FROM public.backup_erasure_targets t
          WHERE t.kind = 'recovery_media_key' AND t.subject_org_id = OLD.org_id AND t.object_key = _key)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  RETURN OLD;
END;
$$;
