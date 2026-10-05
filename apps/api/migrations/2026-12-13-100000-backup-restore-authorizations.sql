-- 2026-12-13-100000-backup-restore-authorizations.sql
--
-- backup_restore_authorizations
--   A technician's confirmed authorization to restore one snapshot that has
--   no usable attestation onto one target device with one command type:
--     reason 'unattested_legacy' / 'unattested'  the snapshot has no attestation
--     reason 'producer_only_other_target'        a device-local snapshot (its
--                                                attestation is the producing
--                                                device's own statement) restored
--                                                onto a different device
--   Inserted only after a two-factor step-up grant bound to exactly that
--   (snapshot, target device, command type) was consumed, in the same
--   transaction as its audit event (audit_written_at). Bound to exactly one
--   thing that performs the restore:
--     command_id         a device command, by the id reserved for it before it
--                        was queued (no FK: the command row does not exist yet
--                        when this row commits; ids are server-generated UUIDs)
--     recovery_token_id  a bare-metal recovery token
--     recovery_id        a bare-metal recovery (its exchange mints the token)
--   Command delivery and recovery authentication trust this row, never a
--   marker in a command payload.
--
--   Every column except org_id is immutable (trigger). org_id may change
--   (device move restamp, org merge repoint). A BEFORE INSERT guard requires
--   the snapshot, the target device and any bound token or recovery to belong
--   to the row's org, and the token or recovery to name the same snapshot and
--   device; it runs as the invoking role, so a parent that is not visible is a
--   refusal.
--
--   TENANCY: shape 1 (direct org_id) with device_id = the restore target, so
--   the device-move trigger (breeze_cascade_device_org_id) and move-org
--   restamp it like every other device_id + org_id table. Every FK except
--   organizations is ON DELETE CASCADE or SET NULL; no composite FK names
--   org_id. Not append-only: device/org erasure deletes these rows (the audit
--   log is the long-term record).
--
-- DDL only: no rows are written, so no breeze.scope election. Idempotent.

CREATE TABLE IF NOT EXISTS backup_restore_authorizations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations (id),
  snapshot_db_id         uuid NOT NULL REFERENCES backup_snapshots (id) ON DELETE CASCADE,
  device_id              uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  command_type           text NOT NULL,
  reason                 text NOT NULL,
  authorized_by_user_id  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  resource_digest        text NOT NULL,
  command_id             uuid NULL,
  recovery_token_id      uuid NULL REFERENCES recovery_tokens (id) ON DELETE CASCADE,
  recovery_id            uuid NULL REFERENCES bare_metal_recoveries (id) ON DELETE CASCADE,
  audit_written_at       timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_restore_authorizations_command_type_chk CHECK (
    command_type IN (
      'backup_restore', 'mssql_restore', 'hyperv_restore', 'vm_restore_from_backup',
      'vm_instant_boot', 'bmr_recover', 'bare_metal_rebuild'
    )
  ),
  CONSTRAINT backup_restore_authorizations_reason_chk CHECK (
    reason IN ('unattested_legacy', 'unattested', 'producer_only_other_target')
  ),
  CONSTRAINT backup_restore_authorizations_digest_chk CHECK (resource_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT backup_restore_authorizations_binding_chk CHECK (
    num_nonnulls(command_id, recovery_token_id, recovery_id) = 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_restore_authorizations_command_uq
  ON backup_restore_authorizations (command_id) WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS backup_restore_authorizations_token_idx
  ON backup_restore_authorizations (recovery_token_id);
CREATE INDEX IF NOT EXISTS backup_restore_authorizations_recovery_idx
  ON backup_restore_authorizations (recovery_id);
CREATE INDEX IF NOT EXISTS backup_restore_authorizations_org_idx
  ON backup_restore_authorizations (org_id);
CREATE INDEX IF NOT EXISTS backup_restore_authorizations_device_idx
  ON backup_restore_authorizations (device_id);
CREATE INDEX IF NOT EXISTS backup_restore_authorizations_snapshot_idx
  ON backup_restore_authorizations (snapshot_db_id);

-- Parent binding at insert time. Invoker rights (no SECURITY DEFINER): under
-- an org-scoped context a parent row of another org is not visible and the
-- insert is refused; under system scope the org comparison refuses it.
CREATE OR REPLACE FUNCTION public.breeze_backup_restore_authorizations_parent_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snap_org uuid;
  device_org uuid;
  bound_org uuid;
  bound_snapshot uuid;
  bound_device uuid;
BEGIN
  SELECT s.org_id INTO snap_org FROM public.backup_snapshots s WHERE s.id = NEW.snapshot_db_id;
  SELECT d.org_id INTO device_org FROM public.devices d WHERE d.id = NEW.device_id;
  IF snap_org IS DISTINCT FROM NEW.org_id OR device_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'backup_restore_authorizations: snapshot and target device must belong to the row''s organization'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.recovery_token_id IS NOT NULL THEN
    SELECT t.org_id, t.snapshot_id, t.device_id INTO bound_org, bound_snapshot, bound_device
      FROM public.recovery_tokens t WHERE t.id = NEW.recovery_token_id;
  ELSIF NEW.recovery_id IS NOT NULL THEN
    SELECT r.org_id, r.snapshot_id, r.device_id INTO bound_org, bound_snapshot, bound_device
      FROM public.bare_metal_recoveries r WHERE r.id = NEW.recovery_id;
  ELSE
    RETURN NEW;
  END IF;
  IF bound_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'backup_restore_authorizations: the bound recovery must belong to the row''s organization'
      USING ERRCODE = '42501';
  END IF;
  IF bound_snapshot IS DISTINCT FROM NEW.snapshot_db_id OR bound_device IS DISTINCT FROM NEW.device_id THEN
    RAISE EXCEPTION 'backup_restore_authorizations: the bound recovery names a different snapshot or device'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_restore_authorizations_parent_guard ON backup_restore_authorizations;
CREATE TRIGGER backup_restore_authorizations_parent_guard
  BEFORE INSERT ON backup_restore_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_restore_authorizations_parent_guard();

-- Immutable except org_id. A SET NULL from a deleted user is the one other
-- change allowed (authorized_by_user_id -> NULL).
CREATE OR REPLACE FUNCTION public.breeze_backup_restore_authorizations_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.snapshot_db_id, NEW.device_id, NEW.command_type, NEW.reason, NEW.resource_digest,
      NEW.command_id, NEW.recovery_token_id, NEW.recovery_id, NEW.audit_written_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.snapshot_db_id, OLD.device_id, OLD.command_type, OLD.reason, OLD.resource_digest,
      OLD.command_id, OLD.recovery_token_id, OLD.recovery_id, OLD.audit_written_at, OLD.created_at)
     OR (NEW.authorized_by_user_id IS DISTINCT FROM OLD.authorized_by_user_id
         AND NEW.authorized_by_user_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'backup_restore_authorizations: rows are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_restore_authorizations_guard ON backup_restore_authorizations;
CREATE TRIGGER backup_restore_authorizations_guard
  BEFORE UPDATE ON backup_restore_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_restore_authorizations_guard();

ALTER TABLE backup_restore_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_restore_authorizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_restore_authorizations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_restore_authorizations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_restore_authorizations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_restore_authorizations;
CREATE POLICY breeze_org_isolation_select ON backup_restore_authorizations FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_restore_authorizations FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_restore_authorizations FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_restore_authorizations FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_restore_authorizations TO breeze_app;
