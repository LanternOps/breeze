-- Wake readiness and wake attempt tracking. Direct org_id tenancy (shape 1).

CREATE TABLE IF NOT EXISTS device_wake_status (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  readiness_state varchar(32),
  reason_codes text[] NOT NULL DEFAULT '{}',
  vendor varchar(32),
  fingerprint text,
  agent_version text,
  proof_fingerprint text,
  collected_at timestamptz,
  received_at timestamptz,
  last_apply_at timestamptz,
  last_wired_adapter_seen_at timestamptz,
  last_came_online_at timestamptz,
  last_apply_result varchar(32),
  details jsonb,
  consecutive_timeouts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_wake_status_readiness_state_chk CHECK (readiness_state IN ('ready', 'needs_reboot', 'not_configured', 'apply_failed', 'firmware_protected', 'unproven', 'no_wired_adapter', 'unsupported_vm'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_wake_status_device_org_fk') THEN
    ALTER TABLE device_wake_status ADD CONSTRAINT device_wake_status_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

ALTER TABLE device_wake_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_wake_status FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_wake_status;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_wake_status;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_wake_status;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_wake_status;

CREATE POLICY breeze_org_isolation_select ON device_wake_status
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_wake_status
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_wake_status
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_wake_status
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON device_wake_status TO breeze_app;

CREATE TABLE IF NOT EXISTS device_wake_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  -- Relay and target cannot be guaranteed to stay in one org, so deliberately use a non-composite FK.
  relay_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  relay_hostname text,
  device_command_id uuid,
  requested_by uuid,
  bulk_id uuid,
  macs text[],
  broadcast text,
  outcome varchar(16) NOT NULL,
  refusal_code varchar(32),
  boot_after_send boolean NOT NULL DEFAULT false,
  send_count integer NOT NULL DEFAULT 1,
  requested_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,
  resolved_at timestamptz,
  CONSTRAINT device_wake_attempts_outcome_chk CHECK (outcome IN ('pending', 'sent', 'send_failed', 'came_online', 'timed_out', 'unknown', 'refused'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_wake_attempts_device_org_fk') THEN
    ALTER TABLE device_wake_attempts ADD CONSTRAINT device_wake_attempts_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

ALTER TABLE device_wake_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_wake_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_wake_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_wake_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_wake_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_wake_attempts;

CREATE POLICY breeze_org_isolation_select ON device_wake_attempts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_wake_attempts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_wake_attempts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_wake_attempts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON device_wake_attempts TO breeze_app;

CREATE UNIQUE INDEX IF NOT EXISTS device_wake_attempts_open_uidx
  ON device_wake_attempts (device_id) WHERE outcome IN ('pending','sent');
CREATE INDEX IF NOT EXISTS device_wake_attempts_relay_idx
  ON device_wake_attempts (relay_device_id) WHERE relay_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_wake_attempts_deadline_idx
  ON device_wake_attempts (deadline_at) WHERE outcome IN ('pending','sent');
CREATE INDEX IF NOT EXISTS device_wake_attempts_device_requested_idx
  ON device_wake_attempts (device_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS device_wake_attempts_org_requested_idx
  ON device_wake_attempts (org_id, requested_at DESC);
