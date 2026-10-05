-- Org erasure keeps backup storage objects and records what they were.
--
-- Erasure (services/tenantCascade.ts) deletes an org's backup_snapshots,
-- backup_snapshot_retirements, backup_snapshot_id_reservations and
-- recovery-media rows. Those rows are the only thing storage GC
-- (jobs/backupRetention.ts) uses to tell whose objects a shared bucket holds,
-- so once they are gone the erased org's prefixes look like unowned orphans
-- to every other org sweeping the same storage identity.
--
-- These two tables are the durable record that survives the erasure:
--
--   backup_erasure_manifests  one row per erased organization
--   backup_erasure_targets    one row per storage target the org owned:
--                               snapshot_prefix     snapshots/<snapshot_id>/
--                               recovery_media_key  one recovery bundle /
--                                                   boot-media object or its
--                                                   checksum/signature sidecar
--
-- Every target is 'fenced': storage GC treats it as owned and never reclaims
-- it. Nothing here deletes anything.
--
-- Tenancy: platform evidence. Deliberately NO org_id column and NO foreign key
-- to organizations — the rows must outlive the organization they describe, so
-- the subject is recorded as subject_org_id / subject_partner_id. No tenant
-- axis, therefore no cascade / merge / export registration; forced RLS with a
-- single system-only policy (same shape as backup_snapshot_id_tombstones).
-- breeze_app holds SELECT/INSERT only (UPDATE/DELETE/TRUNCATE revoked here and
-- re-revoked at boot by ensureAppRole): rows are append-only.
--
-- No customer content: identities are provider::endpoint::bucket or
-- local::<root>, never credentials; object keys and sizes only.
--
-- Further down: backup_erasure_fence_refs (a cache of what fenced manifests
-- reference) and a BEFORE DELETE trigger that fences any source row deleted
-- during an erasure — including through an ON DELETE CASCADE.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS. No inner
-- BEGIN/COMMIT. The migration itself writes no rows (the trigger function's
-- INSERTs run only at erasure time, in system scope), so no system-scope
-- election is needed here.

CREATE TABLE IF NOT EXISTS backup_erasure_manifests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_org_id      uuid NOT NULL,
  subject_partner_id  uuid,
  erasure_job_id      text,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_erasure_manifests_subject_uq UNIQUE (subject_org_id)
);

ALTER TABLE backup_erasure_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_erasure_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backup_erasure_manifests_system_only ON backup_erasure_manifests;
CREATE POLICY backup_erasure_manifests_system_only
  ON backup_erasure_manifests
  FOR ALL
  USING      (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
REVOKE UPDATE, DELETE, TRUNCATE ON backup_erasure_manifests FROM breeze_app;
GRANT SELECT, INSERT ON backup_erasure_manifests TO breeze_app;

CREATE TABLE IF NOT EXISTS backup_erasure_targets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id               uuid NOT NULL REFERENCES backup_erasure_manifests (id),
  subject_org_id            uuid NOT NULL,
  kind                      text NOT NULL,
  -- Which erased row the target was read from.
  source                    text NOT NULL,
  -- NULL only when neither the row, its configuration nor its metadata named
  -- a destination. Storage GC matches fences by snapshot id / object key, not
  -- by identity, so a NULL identity still fences.
  storage_identity          text,
  provider                  text,
  snapshot_id               text,
  object_key                text,
  size_bytes                bigint,
  file_count                integer,
  snapshot_at               timestamptz,
  is_immutable              boolean,
  immutable_until           timestamptz,
  immutability_enforcement  text,
  state                     text NOT NULL DEFAULT 'fenced',
  captured_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_erasure_targets_kind_chk
    CHECK (kind IN ('snapshot_prefix', 'recovery_media_key')),
  CONSTRAINT backup_erasure_targets_source_chk
    CHECK (source IN ('snapshot', 'retirement', 'reservation', 'recovery_media', 'recovery_boot_media')),
  CONSTRAINT backup_erasure_targets_state_chk
    CHECK (state IN ('fenced')),
  CONSTRAINT backup_erasure_targets_shape_chk
    CHECK (
      (kind = 'snapshot_prefix' AND snapshot_id IS NOT NULL AND object_key IS NULL)
      OR (kind = 'recovery_media_key' AND object_key IS NOT NULL)
    )
);

-- One target per (kind, identity, snapshot/key): capture re-runs after a
-- partial cascade insert ON CONFLICT DO NOTHING, never a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS backup_erasure_targets_target_uq
  ON backup_erasure_targets (kind, COALESCE(storage_identity, ''), COALESCE(snapshot_id, ''), COALESCE(object_key, ''));
CREATE INDEX IF NOT EXISTS backup_erasure_targets_snapshot_idx
  ON backup_erasure_targets (snapshot_id) WHERE kind = 'snapshot_prefix';
CREATE INDEX IF NOT EXISTS backup_erasure_targets_object_key_idx
  ON backup_erasure_targets (object_key) WHERE kind = 'recovery_media_key';
CREATE INDEX IF NOT EXISTS backup_erasure_targets_subject_idx
  ON backup_erasure_targets (subject_org_id);
CREATE INDEX IF NOT EXISTS backup_erasure_targets_manifest_idx
  ON backup_erasure_targets (manifest_id);

ALTER TABLE backup_erasure_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_erasure_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backup_erasure_targets_system_only ON backup_erasure_targets;
CREATE POLICY backup_erasure_targets_system_only
  ON backup_erasure_targets
  FOR ALL
  USING      (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
REVOKE UPDATE, DELETE, TRUNCATE ON backup_erasure_targets FROM breeze_app;
GRANT SELECT, INSERT ON backup_erasure_targets TO breeze_app;

-- ── Referenced-key cache for fenced snapshots ──────────────────────────────
--
-- A fenced snapshot's manifest can reference objects under OTHER prefixes (an
-- incremental pointing into its bases). Storage GC keeps those alive. Instead
-- of re-reading every fenced manifest on every run, the keys a fenced manifest
-- references OUTSIDE its own prefix are resolved once per (identity, snapshot)
-- and stored here. A manifest that cannot be read is recorded 'unreadable' with
-- a retry backoff (next_attempt_at); while any fenced snapshot on an identity
-- is unresolved, GC defers retired/orphan reclamation on that identity.
--
-- A cache, not evidence: breeze_app may SELECT/INSERT/UPDATE (system scope
-- only, forced RLS), never DELETE/TRUNCATE — a lost row only means a re-read.

CREATE TABLE IF NOT EXISTS backup_erasure_fence_refs (
  storage_identity  text NOT NULL,
  snapshot_id       text NOT NULL,
  state             text NOT NULL,
  referenced_keys   text[] NOT NULL DEFAULT '{}',
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  next_attempt_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_erasure_fence_refs_pk PRIMARY KEY (storage_identity, snapshot_id),
  CONSTRAINT backup_erasure_fence_refs_state_chk CHECK (state IN ('resolved', 'unreadable'))
);

ALTER TABLE backup_erasure_fence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_erasure_fence_refs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backup_erasure_fence_refs_system_only ON backup_erasure_fence_refs;
CREATE POLICY backup_erasure_fence_refs_system_only
  ON backup_erasure_fence_refs
  FOR ALL
  USING      (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
REVOKE DELETE, TRUNCATE ON backup_erasure_fence_refs FROM breeze_app;
GRANT SELECT, INSERT, UPDATE ON backup_erasure_fence_refs TO breeze_app;

-- ── Fence on delete, during an erasure ──────────────────────────────────────
--
-- The erasure captures every target up front, then walks the cascade table by
-- table. A source row created after that capture (a backup finishing, an id
-- reserved) can still be deleted later — by its own table's step, or by an
-- ON DELETE CASCADE from a parent's step (backup_jobs, devices, backup_configs,
-- recovery_tokens, backup_snapshots). This BEFORE DELETE trigger records the
-- fence for ANY such delete, in the deleting statement's own transaction, but
-- only while `breeze.backup_erasure_org` (set LOCAL by every cascade
-- transaction) names the row's org. Every other delete is untouched.
--
-- A row already fenced for the same subject org (by the up-front capture,
-- which resolves storage identity through configs) is not recorded twice.
-- SECURITY DEFINER with a fixed search_path so the insert does not depend on
-- the privileges of whichever role an FK cascade runs as; RLS on the target
-- tables still applies (forced), and the cascade runs in system scope.

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
      size_bytes, file_count, snapshot_at, is_immutable, immutable_until, immutability_enforcement)
    SELECT _manifest, OLD.org_id, 'snapshot_prefix', _source, _identity,
           NULLIF(split_part(COALESCE(_identity, ''), '::', 1), ''),
           _row->>'snapshot_id',
           (_row->>'size')::bigint, (_row->>'file_count')::integer, (_row->>'timestamp')::timestamptz,
           (_row->>'is_immutable')::boolean, (_row->>'immutable_until')::timestamptz,
           _row->>'immutability_enforcement'
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

DROP TRIGGER IF EXISTS backup_snapshots_erasure_fence ON backup_snapshots;
CREATE TRIGGER backup_snapshots_erasure_fence
  BEFORE DELETE ON backup_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_erasure_fence_on_delete();

DROP TRIGGER IF EXISTS backup_snapshot_retirements_erasure_fence ON backup_snapshot_retirements;
CREATE TRIGGER backup_snapshot_retirements_erasure_fence
  BEFORE DELETE ON backup_snapshot_retirements
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_erasure_fence_on_delete();

DROP TRIGGER IF EXISTS backup_snapshot_id_reservations_erasure_fence ON backup_snapshot_id_reservations;
CREATE TRIGGER backup_snapshot_id_reservations_erasure_fence
  BEFORE DELETE ON backup_snapshot_id_reservations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_erasure_fence_on_delete();

DROP TRIGGER IF EXISTS recovery_media_artifacts_erasure_fence ON recovery_media_artifacts;
CREATE TRIGGER recovery_media_artifacts_erasure_fence
  BEFORE DELETE ON recovery_media_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_erasure_fence_on_delete();

DROP TRIGGER IF EXISTS recovery_boot_media_artifacts_erasure_fence ON recovery_boot_media_artifacts;
CREATE TRIGGER recovery_boot_media_artifacts_erasure_fence
  BEFORE DELETE ON recovery_boot_media_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_erasure_fence_on_delete();
