-- device_restore_point_attempts (#4609, W04 #4755): the durable record of every
-- Windows System Restore checkpoint Breeze requested before a risky action.
--
-- This is the ONLY durable evidence. The command payload is NOT: terminal
-- processing erases it (terminalPayloadErasureSet(), routes/agentWs.ts;
-- routes/agents/commands.ts).
--
-- The row is INSERTed at command-creation time with status='requested' and
-- terminalised from the agent's result (W05+; nothing writes here yet). Without
-- the requested row, an absent row would ambiguously mean policy-off, old
-- agent, lost result, or command timeout -- four very different answers to
-- "did we take a checkpoint?".
--
-- Named ATTEMPTS, not device_restore_points: failed and skipped rows are not
-- restore points, and a created point can later be purged by VSS or rendered
-- unusable under VBS rules. The table records attempts and observations, never
-- a promise of recoverability.
--
-- No json/jsonb/bytea column, deliberately: every field is typed, so the whole
-- table classifies as `included` in CORE_TENANT_EXPORT_POLICY.

CREATE TABLE IF NOT EXISTS device_restore_point_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Idempotency key from the command's restorePoint block. Agent-side command
  -- dedupe is not a durable guarantee against replay after a crash, so this
  -- makes the ledger row idempotent under replay.
  request_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  -- Optional, and deliberately NOT the identity: the direct non-UUID software
  -- path (routes/agentWs.ts) has no device_commands row at all.
  device_command_id uuid,
  trigger varchar(24) NOT NULL
    CONSTRAINT device_restore_point_attempts_trigger_chk
    CHECK (trigger IN ('patch', 'script', 'software_install')),
  status varchar(32) NOT NULL
    CONSTRAINT device_restore_point_attempts_status_chk
    CHECK (status IN (
      'requested',
      'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
      'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed'
    )),
  -- bigint, not integer: Windows sequence numbers are INT64. They are rendered
  -- as decimal STRINGS on the wire and in the API response because they exceed
  -- the JavaScript safe-integer range.
  sequence_number bigint,
  description text,
  message text,
  policy_revision text,
  accepted_existing_point boolean NOT NULL DEFAULT false,
  existing_point_age_minutes integer,
  frequency_minutes integer,
  duration_ms integer,
  requested_at timestamptz NOT NULL DEFAULT now(),  -- server, at command creation
  attempted_at timestamptz,                          -- agent clock
  received_at timestamptz,                           -- server, at result ingest
  script_execution_id uuid,
  software_deployment_id uuid,
  patch_job_id uuid
);

-- Composite (device_id, org_id) FK (pattern: agent_health_observations,
-- db/schema/agentHealth.ts) makes a mismatched tenant stamp impossible: a row
-- can only name a device that actually belongs to the org it claims.
-- ON UPDATE CASCADE restamps org_id when the device moves orgs, which is why
-- the table is in DEVICE_ORG_FK_CASCADE_TABLES (routes/devices/core.ts).
--
-- DEFERRABLE INITIALLY IMMEDIATE is MANDATORY for every composite FK
-- referencing an org_id column: org merge runs SET CONSTRAINTS ALL DEFERRED and
-- re-points parent and child org_id in separate statements, and a
-- non-deferrable constraint aborts the merge with 23503. Enforced by
-- orgLifecycleFoundations.integration.test.ts ("merge contract"), which only
-- runs under Integration Tests -- a unit-green PR still goes red there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_restore_point_attempts_device_org_fk'
  ) THEN
    ALTER TABLE device_restore_point_attempts
      ADD CONSTRAINT device_restore_point_attempts_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- Idempotency: one ledger row per requestId. The ingest path UPDATEs this row
-- rather than inserting a second one.
CREATE UNIQUE INDEX IF NOT EXISTS device_restore_point_attempts_request_uidx
  ON device_restore_point_attempts (request_id);
CREATE INDEX IF NOT EXISTS device_restore_point_attempts_device_requested_idx
  ON device_restore_point_attempts (device_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS device_restore_point_attempts_org_requested_idx
  ON device_restore_point_attempts (org_id, requested_at DESC);
-- Drives the prune job: rows still 'requested' long after the command's own
-- deadline are orphans (offline device, lost result, reaped command).
CREATE INDEX IF NOT EXISTS device_restore_point_attempts_pending_idx
  ON device_restore_point_attempts (requested_at)
  WHERE status = 'requested';

-- RLS shape 1 (direct NOT NULL org_id). breeze_has_org_access already grants
-- system scope, so there is no separate system branch.
ALTER TABLE device_restore_point_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_restore_point_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_restore_point_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_restore_point_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_restore_point_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_restore_point_attempts;

CREATE POLICY breeze_org_isolation_select ON device_restore_point_attempts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_restore_point_attempts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_restore_point_attempts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_restore_point_attempts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON device_restore_point_attempts TO breeze_app;
