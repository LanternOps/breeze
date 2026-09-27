-- 2026-11-05-100600-backup-storage-sessions.sql
--
-- Brokered, read-only storage access for restore-shaped backup commands.
--
-- 1. devices.backup_read_protocol_version
--    The brokered-read protocol the INSTALLED backup helper implements, as the
--    main agent reports it (top-level heartbeat field). 0 (default, every
--    existing row, and every agent that omits the field) = none. Written
--    NON-STICKY on every heartbeat, so a helper downgrade reports back down to
--    0 and the server stops delivering storage sessions to it.
--
-- 2. backup_storage_sessions
--    One row per delivered storage session. A restore-shaped command that is
--    delivered to a capable helper carries a short-lived session instead of the
--    reusable storage destination; the helper exchanges exact object keys for
--    short-lived object URLs through the agent API. Only a SHA-256 of the
--    session token is stored. Every row is bound to the organization, the
--    command, the EXECUTING device (device_id) and the snapshot's SOURCE
--    device, the internal snapshot, the storage configuration and the storage
--    identity pinned when it was minted, plus a lease (expires_at) inside an
--    absolute deadline. Redelivery mints a new generation; earlier generations
--    stay usable until their own expiry. Resolution is rate limited per
--    session (rate_* columns: two token buckets, calls and objects) under an
--    absolute lifetime ceiling (max_calls / max_resolved_objects).
--
--    TENANCY: shape 1 (direct org_id) with the org_id denormalised from the
--    executing device, so the device-move trigger (breeze_cascade_device_org_id)
--    and move-org restamp it like every other device_id + org_id table. Every
--    FK carries ON DELETE CASCADE: a session is meaningless without its
--    command, device, snapshot or configuration. No composite FK names an
--    org_id column, so the org-merge deferral contract does not apply; the
--    endpoints re-check org, device, snapshot and storage identity on every
--    call instead, which also fails closed after a device or snapshot moves.
--
-- 3. Revocation when the command stops being deliverable.
--    An AFTER UPDATE OF status trigger on device_commands stamps revoked_at on
--    the command's sessions once the status leaves pending/sent. It runs as the
--    invoking role under the caller's RLS context (no SECURITY DEFINER); a
--    caller that cannot see the rows simply updates none, and the endpoints
--    independently refuse any session whose command is no longer pending/sent.
--
-- DDL only: no rows written, so no breeze.scope election. Idempotent.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS backup_read_protocol_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS backup_storage_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations (id),
  command_id             uuid NOT NULL REFERENCES device_commands (id) ON DELETE CASCADE,
  device_id              uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  source_device_id       uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  snapshot_id            uuid NOT NULL REFERENCES backup_snapshots (id) ON DELETE CASCADE,
  config_id              uuid NOT NULL REFERENCES backup_configs (id) ON DELETE CASCADE,
  storage_identity       text NOT NULL,
  scope                  text NOT NULL DEFAULT 'snapshot_read',
  control_keys           text[] NOT NULL DEFAULT '{}'::text[],
  use_file_index         boolean NOT NULL,
  token_hash             text NOT NULL,
  generation             integer NOT NULL,
  max_calls              integer NOT NULL,
  max_resolved_objects   integer NOT NULL,
  expires_at             timestamptz NOT NULL,
  deadline               timestamptz NOT NULL,
  revoked_at             timestamptz NULL,
  revoked_reason         text NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz NULL,
  resolved_object_count  integer NOT NULL DEFAULT 0,
  call_count             integer NOT NULL DEFAULT 0,
  rate_calls_available   double precision NOT NULL,
  rate_objects_available double precision NOT NULL,
  rate_refilled_at       timestamptz NOT NULL,
  CONSTRAINT backup_storage_sessions_scope_chk CHECK (scope IN ('snapshot_read')),
  CONSTRAINT backup_storage_sessions_generation_chk CHECK (generation >= 1),
  CONSTRAINT backup_storage_sessions_lease_chk CHECK (expires_at <= deadline),
  CONSTRAINT backup_storage_sessions_budget_chk CHECK (
    max_calls > 0 AND max_resolved_objects > 0
    AND call_count >= 0 AND call_count <= max_calls
    AND resolved_object_count >= 0 AND resolved_object_count <= max_resolved_objects
    AND rate_calls_available >= 0 AND rate_objects_available >= 0
  ),
  CONSTRAINT backup_storage_sessions_token_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_storage_sessions_token_hash_uq
  ON backup_storage_sessions (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS backup_storage_sessions_command_generation_uq
  ON backup_storage_sessions (command_id, generation);
CREATE INDEX IF NOT EXISTS backup_storage_sessions_org_idx
  ON backup_storage_sessions (org_id);
CREATE INDEX IF NOT EXISTS backup_storage_sessions_device_idx
  ON backup_storage_sessions (device_id);
CREATE INDEX IF NOT EXISTS backup_storage_sessions_source_device_idx
  ON backup_storage_sessions (source_device_id);
CREATE INDEX IF NOT EXISTS backup_storage_sessions_snapshot_idx
  ON backup_storage_sessions (snapshot_id);
CREATE INDEX IF NOT EXISTS backup_storage_sessions_config_idx
  ON backup_storage_sessions (config_id);

ALTER TABLE backup_storage_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_storage_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_storage_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_storage_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_storage_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_storage_sessions;
CREATE POLICY breeze_org_isolation_select ON backup_storage_sessions FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_storage_sessions FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_storage_sessions FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_storage_sessions FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_storage_sessions TO breeze_app;

CREATE OR REPLACE FUNCTION public.breeze_revoke_backup_storage_sessions_on_command_end()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE backup_storage_sessions
     SET revoked_at = now(),
         revoked_reason = 'command_' || NEW.status
   WHERE command_id = NEW.id
     AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS device_commands_revoke_backup_storage_sessions ON device_commands;
CREATE TRIGGER device_commands_revoke_backup_storage_sessions
  AFTER UPDATE OF status ON device_commands
  FOR EACH ROW
  WHEN (NEW.status NOT IN ('pending', 'sent') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.breeze_revoke_backup_storage_sessions_on_command_end();
