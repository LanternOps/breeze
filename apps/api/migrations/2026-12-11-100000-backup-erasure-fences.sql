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
-- Idempotent: IF NOT EXISTS / DROP ... IF EXISTS. No inner BEGIN/COMMIT. No
-- row writes, so no system-scope election is needed.

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
