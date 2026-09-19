-- Deterministic peripheral-policy v2 desired state and append-only delivery
-- evidence. The state projection is mutable; delivery evidence is not.

ALTER TABLE peripheral_policies
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'peripheral_policies_priority_chk'
      AND conrelid = 'peripheral_policies'::regclass
  ) THEN
    ALTER TABLE peripheral_policies
      ADD CONSTRAINT peripheral_policies_priority_chk
      CHECK (priority BETWEEN 0 AND 1000);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS peripheral_policy_device_states (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  desired_phase varchar(16) NOT NULL,
  desired_revision integer NOT NULL,
  desired_digest varchar(71) NOT NULL,
  desired_envelope jsonb NOT NULL,
  delivery_status varchar(16) NOT NULL,
  applied_phase varchar(16),
  applied_revision integer,
  applied_digest varchar(71),
  last_error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peripheral_policy_device_states_device_org_fk
    FOREIGN KEY (device_id, org_id)
    REFERENCES devices(id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT peripheral_policy_device_states_desired_phase_chk
    CHECK (desired_phase IN ('clear_legacy', 'enforce')),
  CONSTRAINT peripheral_policy_device_states_applied_phase_chk
    CHECK (applied_phase IS NULL OR applied_phase IN ('clear_legacy', 'enforce')),
  CONSTRAINT peripheral_policy_device_states_status_chk
    CHECK (delivery_status IN ('pending', 'applied', 'rejected')),
  CONSTRAINT peripheral_policy_device_states_revision_chk
    CHECK (desired_revision > 0 AND (applied_revision IS NULL OR applied_revision > 0)),
  CONSTRAINT peripheral_policy_device_states_desired_digest_chk
    CHECK (desired_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT peripheral_policy_device_states_applied_digest_chk
    CHECK (applied_digest IS NULL OR applied_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT peripheral_policy_device_states_envelope_object_chk
    CHECK (jsonb_typeof(desired_envelope) = 'object'),
  CONSTRAINT peripheral_policy_device_states_applied_tuple_chk
    CHECK (
      (applied_phase IS NULL AND applied_revision IS NULL AND applied_digest IS NULL)
      OR
      (applied_phase IS NOT NULL AND applied_revision IS NOT NULL AND applied_digest IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS peripheral_policy_device_states_org_idx
  ON peripheral_policy_device_states (org_id);
CREATE INDEX IF NOT EXISTS peripheral_policy_device_states_pending_idx
  ON peripheral_policy_device_states (updated_at, device_id)
  WHERE delivery_status = 'pending';

CREATE TABLE IF NOT EXISTS peripheral_policy_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  command_id uuid NOT NULL,
  event_kind varchar(16) NOT NULL,
  phase varchar(16) NOT NULL,
  revision integer NOT NULL,
  digest varchar(71) NOT NULL,
  outcome varchar(16),
  reason_code varchar(64),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peripheral_policy_delivery_events_device_org_fk
    FOREIGN KEY (device_id, org_id)
    REFERENCES devices(id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT peripheral_policy_delivery_events_kind_chk
    CHECK (event_kind IN ('requested', 'result')),
  CONSTRAINT peripheral_policy_delivery_events_phase_chk
    CHECK (phase IN ('clear_legacy', 'enforce')),
  CONSTRAINT peripheral_policy_delivery_events_revision_chk
    CHECK (revision > 0),
  CONSTRAINT peripheral_policy_delivery_events_digest_chk
    CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT peripheral_policy_delivery_events_outcome_chk
    CHECK (outcome IS NULL OR outcome IN ('applied', 'rejected')),
  CONSTRAINT peripheral_policy_delivery_events_kind_outcome_chk
    CHECK (
      (event_kind = 'requested' AND outcome IS NULL)
      OR
      (event_kind = 'result' AND outcome IN ('applied', 'rejected'))
    ),
  CONSTRAINT peripheral_policy_delivery_events_evidence_object_chk
    CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS peripheral_policy_delivery_events_command_kind_uq
  ON peripheral_policy_delivery_events (device_id, command_id, event_kind);
CREATE INDEX IF NOT EXISTS peripheral_policy_delivery_events_org_time_idx
  ON peripheral_policy_delivery_events (org_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS peripheral_policy_delivery_events_device_time_idx
  ON peripheral_policy_delivery_events (device_id, occurred_at DESC, id DESC);

ALTER TABLE peripheral_policy_device_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE peripheral_policy_device_states FORCE ROW LEVEL SECURITY;
ALTER TABLE peripheral_policy_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE peripheral_policy_delivery_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON peripheral_policy_device_states;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON peripheral_policy_device_states;
DROP POLICY IF EXISTS breeze_org_isolation_update ON peripheral_policy_device_states;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON peripheral_policy_device_states;
CREATE POLICY breeze_org_isolation_select ON peripheral_policy_device_states
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON peripheral_policy_device_states
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON peripheral_policy_device_states
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON peripheral_policy_device_states
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON peripheral_policy_delivery_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON peripheral_policy_delivery_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON peripheral_policy_delivery_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON peripheral_policy_delivery_events;
CREATE POLICY breeze_org_isolation_select ON peripheral_policy_delivery_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON peripheral_policy_delivery_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON peripheral_policy_delivery_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON peripheral_policy_delivery_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES
  ON peripheral_policy_device_states TO breeze_app;
GRANT SELECT, INSERT, UPDATE, REFERENCES
  ON peripheral_policy_delivery_events TO breeze_app;
REVOKE DELETE, TRUNCATE ON peripheral_policy_delivery_events FROM breeze_app;
GRANT SELECT, DELETE ON peripheral_policy_delivery_events TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON peripheral_policy_delivery_events FROM breeze_audit_admin;

CREATE OR REPLACE FUNCTION peripheral_policy_delivery_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF allow_retention = '1' OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Cross-org device moves restamp tenant metadata only. The device row is
    -- updated first, so bind the permitted restamp to its authoritative owner.
    -- A database trigger on devices already restamps device-owned rows before
    -- the application move loop reaches them, so the loop's UPDATE may be a
    -- no-op. Both the real restamp and that no-op are safe when every evidence
    -- field is unchanged and org_id matches the device's current owner.
    IF (to_jsonb(NEW) - 'org_id') = (to_jsonb(OLD) - 'org_id')
       AND EXISTS (
         SELECT 1 FROM devices
         WHERE id = NEW.device_id AND org_id = NEW.org_id
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'peripheral policy delivery events are append-only',
    HINT = 'Evidence cannot be modified or deleted. Retention uses breeze_audit_admin plus breeze.allow_audit_retention=1.';
END;
$$;

DROP TRIGGER IF EXISTS peripheral_policy_delivery_events_block_update
  ON peripheral_policy_delivery_events;
CREATE TRIGGER peripheral_policy_delivery_events_block_update
  BEFORE UPDATE ON peripheral_policy_delivery_events
  FOR EACH ROW EXECUTE FUNCTION peripheral_policy_delivery_events_append_only();

DROP TRIGGER IF EXISTS peripheral_policy_delivery_events_block_delete
  ON peripheral_policy_delivery_events;
CREATE TRIGGER peripheral_policy_delivery_events_block_delete
  BEFORE DELETE ON peripheral_policy_delivery_events
  FOR EACH ROW EXECUTE FUNCTION peripheral_policy_delivery_events_append_only();
