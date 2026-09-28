-- 2026-11-08-110000-backup-snapshot-attestations.sql
--
-- 1. backup_snapshot_attestations
--    One record per snapshot, committing to the exact bytes of the snapshot's
--    control objects (manifest, layout manifest, system-state manifest) as
--    reported by the device that produced the snapshot, over its authenticated
--    result channel. `statement` is stored verbatim; `statement_sha256` is
--    over those bytes. `signature_alg`/`signature` are reserved for
--    device-side signing and are NULL in statement format 1.
--
--    verification_mode:
--      server_fetched  the API fetches the committed objects itself and moves
--                      the row pending -> verified | mismatch, exactly once.
--      producer_only   the destination is on the device's own disk, which the
--                      API cannot read; the row is terminal on insert.
--
--    Every column except org_id, status, verify_error, verified_at,
--    attempt_count and next_attempt_at is immutable (trigger); those four
--    freeze once the row leaves 'pending'. attempt_count/next_attempt_at
--    schedule verification retries when storage cannot be read: the row stays
--    'pending' (a storage failure never decides it), and after a bounded
--    number of attempts it is no longer retried automatically. org_id may change (device move restamp, org merge repoint).
--    Rows are never created by storage reconciliation. A BEFORE INSERT guard
--    requires the snapshot, job and device to belong to the row's org and the
--    snapshot row to name the same job, device and snapshot id; it runs as the
--    invoking role, so a parent that is not visible is a refusal.
--
--    TENANCY: shape 1 (direct org_id), denormalised from the device, so the
--    device-move trigger (breeze_cascade_device_org_id) and move-org restamp
--    it like every other device_id + org_id table. Every FK except the
--    organizations one is ON DELETE CASCADE; no composite FK names org_id.
--
-- 2. backup_snapshots.integrity_status
--    Projection of the attestation for display and reports; restore decisions
--    read backup_snapshot_attestations. 'unattested_legacy' (the default) =
--    produced by a helper that does not report attestations: every existing
--    row, and new rows from older helpers. Never backfilled.
--
-- 3. backup_snapshots.result_provenance
--    How the row came to exist, written once at row creation: 'agent_result'
--    (an authenticated result for a dispatched job) or 'reconcile' (adopted
--    from storage); a later authenticated result from the producing device
--    for a reconciled row sets 'agent_result_after_reconcile'. NULL = created
--    before this column existed.
--
-- DDL only: no rows are written (the ADD COLUMN defaults fill existing rows),
-- so no breeze.scope election. Idempotent.

CREATE TABLE IF NOT EXISTS backup_snapshot_attestations (
  id                                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                               uuid NOT NULL REFERENCES organizations (id),
  snapshot_db_id                       uuid NOT NULL REFERENCES backup_snapshots (id) ON DELETE CASCADE,
  job_id                               uuid NOT NULL REFERENCES backup_jobs (id) ON DELETE CASCADE,
  device_id                            uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  provider_snapshot_id                 text NOT NULL,
  storage_identity                     text NOT NULL,
  key_layout                           text NOT NULL,
  dispatched_base_provider_snapshot_id text NULL,
  parent_provider_snapshot_id          text NULL,
  verification_mode                    text NOT NULL,
  accepted_via                         text NOT NULL,
  result_received_at                   timestamptz NOT NULL,
  format_version                       integer NOT NULL,
  statement                            text NOT NULL,
  statement_sha256                     text NOT NULL,
  manifest_key                         text NOT NULL,
  manifest_sha256                      text NOT NULL,
  manifest_size                        bigint NOT NULL,
  layout_sha256                        text NULL,
  layout_size                          bigint NULL,
  system_state_manifest_sha256         text NULL,
  system_state_manifest_size           bigint NULL,
  signature_alg                        text NULL,
  signature                            text NULL,
  status                               text NOT NULL DEFAULT 'pending',
  verify_error                         text NULL,
  verified_at                          timestamptz NULL,
  attempt_count                        integer NOT NULL DEFAULT 0,
  next_attempt_at                      timestamptz NULL,
  created_at                           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_snapshot_attestations_status_chk
    CHECK (status IN ('pending', 'verified', 'mismatch', 'producer_only')),
  CONSTRAINT backup_snapshot_attestations_mode_chk CHECK (
    (verification_mode = 'server_fetched' AND status IN ('pending', 'verified', 'mismatch'))
    OR (verification_mode = 'producer_only' AND status = 'producer_only')
  ),
  CONSTRAINT backup_snapshot_attestations_via_chk
    CHECK (accepted_via IN ('agent_result', 'late_agent_result')),
  CONSTRAINT backup_snapshot_attestations_parent_chk CHECK (
    parent_provider_snapshot_id IS NULL
    OR parent_provider_snapshot_id = dispatched_base_provider_snapshot_id
  ),
  CONSTRAINT backup_snapshot_attestations_format_chk CHECK (format_version = 1),
  CONSTRAINT backup_snapshot_attestations_key_layout_chk CHECK (key_layout = 'legacy_flat'),
  CONSTRAINT backup_snapshot_attestations_sha_chk CHECK (
    statement_sha256 ~ '^[0-9a-f]{64}$'
    AND manifest_sha256 ~ '^[0-9a-f]{64}$'
    AND (layout_sha256 IS NULL OR layout_sha256 ~ '^[0-9a-f]{64}$')
    AND (system_state_manifest_sha256 IS NULL OR system_state_manifest_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT backup_snapshot_attestations_size_chk CHECK (
    manifest_size >= 0
    AND (layout_size IS NULL OR layout_size >= 0)
    AND (system_state_manifest_size IS NULL OR system_state_manifest_size >= 0)
  ),
  CONSTRAINT backup_snapshot_attestations_pair_chk CHECK (
    (layout_sha256 IS NULL) = (layout_size IS NULL)
    AND (system_state_manifest_sha256 IS NULL) = (system_state_manifest_size IS NULL)
  ),
  CONSTRAINT backup_snapshot_attestations_attempt_chk CHECK (attempt_count >= 0),
  CONSTRAINT backup_snapshot_attestations_signature_chk CHECK (
    (signature_alg IS NULL) = (signature IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_snapshot_attestations_snapshot_uq
  ON backup_snapshot_attestations (snapshot_db_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_attestations_org_idx
  ON backup_snapshot_attestations (org_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_attestations_device_idx
  ON backup_snapshot_attestations (device_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_attestations_job_idx
  ON backup_snapshot_attestations (job_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_attestations_pending_idx
  ON backup_snapshot_attestations (next_attempt_at, created_at)
  WHERE status = 'pending';

-- Parent binding at insert time. Invoker rights (no SECURITY DEFINER): under
-- an org-scoped context a parent row of another org is not visible and the
-- insert is refused; under system scope the org comparison refuses it.
CREATE OR REPLACE FUNCTION public.breeze_backup_snapshot_attestations_parent_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snap_org uuid;
  snap_job uuid;
  snap_device uuid;
  snap_id text;
  job_org uuid;
  job_device uuid;
  device_org uuid;
BEGIN
  SELECT s.org_id, s.job_id, s.device_id, s.snapshot_id
    INTO snap_org, snap_job, snap_device, snap_id
    FROM public.backup_snapshots s
   WHERE s.id = NEW.snapshot_db_id;
  SELECT j.org_id, j.device_id INTO job_org, job_device
    FROM public.backup_jobs j
   WHERE j.id = NEW.job_id;
  SELECT d.org_id INTO device_org
    FROM public.devices d
   WHERE d.id = NEW.device_id;

  IF snap_org IS DISTINCT FROM NEW.org_id
     OR job_org IS DISTINCT FROM NEW.org_id
     OR device_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'backup_snapshot_attestations: snapshot, job and device must belong to the row''s organization'
      USING ERRCODE = '42501';
  END IF;
  IF snap_job IS DISTINCT FROM NEW.job_id
     OR snap_device IS DISTINCT FROM NEW.device_id
     OR job_device IS DISTINCT FROM NEW.device_id
     OR snap_id IS DISTINCT FROM NEW.provider_snapshot_id THEN
    RAISE EXCEPTION 'backup_snapshot_attestations: row does not match its snapshot''s job, device and snapshot id'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_snapshot_attestations_parent_guard ON backup_snapshot_attestations;
CREATE TRIGGER backup_snapshot_attestations_parent_guard
  BEFORE INSERT ON backup_snapshot_attestations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_snapshot_attestations_parent_guard();

CREATE OR REPLACE FUNCTION public.breeze_backup_snapshot_attestations_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.snapshot_db_id, NEW.job_id, NEW.device_id, NEW.provider_snapshot_id,
      NEW.storage_identity, NEW.key_layout, NEW.dispatched_base_provider_snapshot_id,
      NEW.parent_provider_snapshot_id, NEW.verification_mode, NEW.accepted_via,
      NEW.result_received_at, NEW.format_version, NEW.statement, NEW.statement_sha256,
      NEW.manifest_key, NEW.manifest_sha256, NEW.manifest_size, NEW.layout_sha256,
      NEW.layout_size, NEW.system_state_manifest_sha256, NEW.system_state_manifest_size,
      NEW.signature_alg, NEW.signature, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.snapshot_db_id, OLD.job_id, OLD.device_id, OLD.provider_snapshot_id,
      OLD.storage_identity, OLD.key_layout, OLD.dispatched_base_provider_snapshot_id,
      OLD.parent_provider_snapshot_id, OLD.verification_mode, OLD.accepted_via,
      OLD.result_received_at, OLD.format_version, OLD.statement, OLD.statement_sha256,
      OLD.manifest_key, OLD.manifest_sha256, OLD.manifest_size, OLD.layout_sha256,
      OLD.layout_size, OLD.system_state_manifest_sha256, OLD.system_state_manifest_size,
      OLD.signature_alg, OLD.signature, OLD.created_at)
  THEN
    RAISE EXCEPTION 'backup_snapshot_attestations: attested columns are immutable';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.verify_error IS DISTINCT FROM OLD.verify_error
          OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
          OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
          OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at) THEN
    RAISE EXCEPTION 'backup_snapshot_attestations: verification outcome of a % row is immutable', OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('verified', 'mismatch')) THEN
    RAISE EXCEPTION 'backup_snapshot_attestations: status % -> % not allowed', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_snapshot_attestations_guard ON backup_snapshot_attestations;
CREATE TRIGGER backup_snapshot_attestations_guard
  BEFORE UPDATE ON backup_snapshot_attestations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_snapshot_attestations_guard();

ALTER TABLE backup_snapshot_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_attestations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshot_attestations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshot_attestations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshot_attestations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshot_attestations;
CREATE POLICY breeze_org_isolation_select ON backup_snapshot_attestations FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_snapshot_attestations FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_snapshot_attestations FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_snapshot_attestations FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_snapshot_attestations TO breeze_app;

ALTER TABLE backup_snapshots
  ADD COLUMN IF NOT EXISTS integrity_status text NOT NULL DEFAULT 'unattested_legacy';
DO $$
BEGIN
  ALTER TABLE backup_snapshots
    ADD CONSTRAINT backup_snapshots_integrity_status_chk CHECK (
      integrity_status IN ('unattested_legacy', 'unattested', 'pending', 'attested', 'producer_only', 'attestation_failed')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE backup_snapshots
  ADD COLUMN IF NOT EXISTS result_provenance text NULL;
DO $$
BEGIN
  ALTER TABLE backup_snapshots
    ADD CONSTRAINT backup_snapshots_result_provenance_chk CHECK (
      result_provenance IS NULL
      OR result_provenance IN ('agent_result', 'reconcile', 'agent_result_after_reconcile')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
