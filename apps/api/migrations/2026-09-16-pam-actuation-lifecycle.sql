-- S0 Track E: durable, tenant-bound PAM actuation desired state and evidence.
-- Additive after Track D's 2026-09-15 migration; safe to re-run for contract tests.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS pam_lifetime_protocol_version integer NOT NULL DEFAULT 0;

ALTER TABLE elevation_requests
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE elevation_requests
  DROP CONSTRAINT IF EXISTS elevation_requests_revision_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_revision_chk CHECK (revision >= 1);

-- 2026-05-27 added the actuating enum member but did not widen this CHECK,
-- making the route's documented approved -> actuating transition impossible.
ALTER TABLE elevation_requests
  DROP CONSTRAINT IF EXISTS elevation_requests_status_timestamps_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_status_timestamps_chk CHECK (
    (status = 'pending')
    OR (status IN ('approved', 'auto_approved', 'actuating') AND approved_at IS NOT NULL)
    OR (status = 'denied' AND denial_reason IS NOT NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  );

DO $$
DECLARE device_rows bigint; request_rows bigint;
BEGIN
  SELECT count(*) INTO device_rows FROM devices WHERE pam_lifetime_protocol_version = 0;
  SELECT count(*) INTO request_rows FROM elevation_requests WHERE revision = 1;
  RAISE WARNING 'pam lifecycle migration: capability rows at fail-closed v0=%', device_rows;
  RAISE WARNING 'pam lifecycle migration: request rows at revision 1=%', request_rows;
END $$;

CREATE TABLE IF NOT EXISTS pam_actuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  elevation_request_id uuid NOT NULL,
  request_revision integer NOT NULL,
  generation integer NOT NULL,
  desired_state text NOT NULL,
  observed_state text NOT NULL,
  current_command_id uuid REFERENCES device_commands(id) ON DELETE SET NULL,
  target_executable_path text NOT NULL,
  target_executable_hash varchar(64),
  subject_username varchar(255) NOT NULL,
  expires_at timestamptz,
  cleanup_requested_at timestamptz,
  cleaned_at timestamptz,
  failure_code varchar(128),
  latest_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pam_actuations_request_revision_key
    UNIQUE (elevation_request_id, request_revision),
  CONSTRAINT pam_actuations_id_org_id_key UNIQUE (id, org_id),
  CONSTRAINT pam_actuations_device_id_org_id_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT pam_actuations_elevation_request_id_org_id_fkey
    FOREIGN KEY (elevation_request_id, org_id) REFERENCES elevation_requests(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT pam_actuations_request_revision_chk CHECK (request_revision >= 1),
  CONSTRAINT pam_actuations_generation_chk CHECK (generation >= 1),
  CONSTRAINT pam_actuations_desired_state_chk CHECK (desired_state IN ('active', 'cleanup')),
  CONSTRAINT pam_actuations_observed_state_chk CHECK (
    observed_state IN (
      'pending_dispatch', 'dispatched', 'received', 'verified_active',
      'cleanup_pending', 'cleaned', 'failed', 'legacy_untracked'
    )
  ),
  CONSTRAINT pam_actuations_latest_evidence_object_chk
    CHECK (jsonb_typeof(latest_evidence) = 'object'),
  CONSTRAINT pam_actuations_cleaned_state_chk
    CHECK (cleaned_at IS NULL OR observed_state = 'cleaned')
);

CREATE INDEX IF NOT EXISTS pam_actuations_device_generation_idx
  ON pam_actuations (device_id, generation DESC);
CREATE INDEX IF NOT EXISTS pam_actuations_due_dispatch_idx
  ON pam_actuations (updated_at, id)
  WHERE observed_state IN ('pending_dispatch', 'cleanup_pending');
CREATE INDEX IF NOT EXISTS pam_actuations_active_reconcile_idx
  ON pam_actuations (device_id, expires_at, id)
  WHERE desired_state = 'active' AND observed_state <> 'cleaned';
CREATE INDEX IF NOT EXISTS pam_actuations_cleanup_reconcile_idx
  ON pam_actuations (device_id, generation, id)
  WHERE desired_state = 'cleanup' AND observed_state <> 'cleaned';

CREATE TABLE IF NOT EXISTS pam_actuation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  actuation_id uuid NOT NULL,
  generation integer NOT NULL,
  result_kind text NOT NULL,
  failure_code varchar(128),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pam_actuation_results_actuation_id_org_id_fkey
    FOREIGN KEY (actuation_id, org_id) REFERENCES pam_actuations(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT pam_actuation_results_device_id_org_id_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT pam_actuation_results_generation_chk CHECK (generation >= 1),
  CONSTRAINT pam_actuation_results_kind_chk
    CHECK (result_kind IN ('received', 'verified_active', 'cleaned', 'failed')),
  CONSTRAINT pam_actuation_results_evidence_object_chk
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT pam_actuation_results_failure_code_chk
    CHECK (result_kind = 'failed' OR failure_code IS NULL),
  CONSTRAINT pam_actuation_results_observation_key
    UNIQUE (actuation_id, generation, result_kind, observation_id)
);

CREATE INDEX IF NOT EXISTS pam_actuation_results_actuation_generation_idx
  ON pam_actuation_results (actuation_id, generation, received_at, id);
CREATE INDEX IF NOT EXISTS pam_actuation_results_org_received_idx
  ON pam_actuation_results (org_id, received_at DESC, id DESC);

CREATE OR REPLACE FUNCTION pam_actuations_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM actuation generation cannot decrease';
  END IF;
  IF OLD.desired_state = 'cleanup' AND NEW.desired_state <> 'cleanup' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM cleanup tombstone is irreversible';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pam_actuations_transition_guard ON pam_actuations;
CREATE TRIGGER pam_actuations_transition_guard
  BEFORE UPDATE ON pam_actuations
  FOR EACH ROW EXECUTE FUNCTION pam_actuations_transition_guard();

ALTER TABLE pam_actuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pam_actuations FORCE ROW LEVEL SECURITY;
ALTER TABLE pam_actuation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE pam_actuation_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON pam_actuations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON pam_actuations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON pam_actuations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON pam_actuations;
CREATE POLICY breeze_org_isolation_select ON pam_actuations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON pam_actuations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON pam_actuations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON pam_actuations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON pam_actuation_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON pam_actuation_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON pam_actuation_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON pam_actuation_results;
CREATE POLICY breeze_org_isolation_select ON pam_actuation_results
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON pam_actuation_results
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
-- Keep rows RLS-visible to the command that attempts a mutation so the
-- table-level REVOKE below produces a literal 42501 instead of a silent
-- zero-row UPDATE/DELETE. The append-only trigger is a second guard, and the
-- DELETE policy also lets the system-scoped audit-admin retention path see it.
CREATE POLICY breeze_org_isolation_update ON pam_actuation_results
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON pam_actuation_results
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON pam_actuations TO breeze_app;
GRANT SELECT, INSERT, REFERENCES ON pam_actuation_results TO breeze_app;
REVOKE UPDATE, DELETE, TRUNCATE ON pam_actuation_results FROM breeze_app;
GRANT SELECT, DELETE ON pam_actuation_results TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON pam_actuation_results FROM breeze_audit_admin;

CREATE OR REPLACE FUNCTION pam_actuation_results_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' AND (allow_retention = '1' OR pg_trigger_depth() > 1) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'PAM actuation results are append-only',
    HINT = 'Retention uses breeze_audit_admin plus breeze.allow_audit_retention=1.';
END;
$$;

DROP TRIGGER IF EXISTS pam_actuation_results_block_mutation ON pam_actuation_results;
CREATE TRIGGER pam_actuation_results_block_mutation
  BEFORE UPDATE OR DELETE ON pam_actuation_results
  FOR EACH ROW EXECUTE FUNCTION pam_actuation_results_append_only();

ALTER TABLE intent_outbox ALTER COLUMN intent_id DROP NOT NULL;
ALTER TABLE intent_outbox ADD COLUMN IF NOT EXISTS pam_actuation_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'intent_outbox'::regclass
      AND conname = 'intent_outbox_pam_actuation_id_fkey'
  ) THEN
    ALTER TABLE intent_outbox
      ADD CONSTRAINT intent_outbox_pam_actuation_id_fkey
      FOREIGN KEY (pam_actuation_id) REFERENCES pam_actuations(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE intent_outbox DROP CONSTRAINT IF EXISTS intent_outbox_parent_xor_chk;
ALTER TABLE intent_outbox ADD CONSTRAINT intent_outbox_parent_xor_chk
  CHECK ((intent_id IS NULL) <> (pam_actuation_id IS NULL));
ALTER TABLE intent_outbox DROP CONSTRAINT IF EXISTS intent_outbox_event_type_check;
ALTER TABLE intent_outbox ADD CONSTRAINT intent_outbox_event_type_check CHECK (
  event_type IN (
    'intent_created', 'intent_approved', 'intent_rejected', 'intent_expired',
    'pam.desired_state_changed'
  )
);
CREATE INDEX IF NOT EXISTS intent_outbox_pam_actuation_id_idx
  ON intent_outbox (pam_actuation_id);

-- Quarantine the shipping v1 states. The old schema names active approvals
-- approved/auto_approved; actuating is the one-shot route's in-flight state.
DO $$
DECLARE batch_rows integer; total_rows bigint := 0;
BEGIN
  LOOP
    WITH legacy AS (
      SELECT r.id
      FROM elevation_requests r
      WHERE r.status IN ('approved', 'auto_approved', 'actuating')
        AND NOT EXISTS (
          SELECT 1 FROM pam_actuations a
          WHERE a.elevation_request_id = r.id AND a.request_revision = r.revision
        )
      ORDER BY r.id
      LIMIT 1000
    )
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username, expires_at,
      cleanup_requested_at, latest_evidence
    )
    SELECT
      r.org_id, r.device_id, r.id, r.revision, 1,
      'cleanup', 'legacy_untracked', COALESCE(r.target_executable_path, ''),
      r.target_executable_hash, r.subject_username, r.expires_at,
      now(), jsonb_build_object('disposition', 'blocked_manual_remediation', 'legacyStatus', r.status)
    FROM elevation_requests r
    JOIN legacy ON legacy.id = r.id
    ON CONFLICT (elevation_request_id, request_revision) DO NOTHING;

    GET DIAGNOSTICS batch_rows = ROW_COUNT;
    total_rows := total_rows + batch_rows;
    RAISE WARNING 'pam lifecycle migration: quarantined legacy batch rows=%', batch_rows;
    EXIT WHEN batch_rows = 0;
  END LOOP;
  RAISE WARNING 'pam lifecycle migration: total legacy rows quarantined=%', total_rows;
END $$;
