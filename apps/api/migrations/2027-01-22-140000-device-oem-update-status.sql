-- device_oem_update_status (#11068, feature #11065 W03): one row per device for
-- the vendor update (Dell, Surface, HP, Lenovo) command `oem_update_run`.
--
-- Device state, not config, so `org_id NOT NULL` is the DEVICE's org and the
-- partner-wide-first shape does not apply. RLS shape 1 (direct org_id).
--
-- No json/jsonb/bytea column: every column classifies `included` in
-- CORE_TENANT_EXPORT_POLICY. Run history stays in device_commands.result, so
-- `last_command_id` is a bare uuid: device_commands is system-scoped and its
-- rows have their own retention.
--
-- No rows are written here, so no system-scope election is needed.

CREATE TABLE IF NOT EXISTS device_oem_update_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL when no lane applies to this device.
  lane varchar(16)
    CONSTRAINT device_oem_update_status_lane_chk
    CHECK (lane IS NULL OR lane IN ('dell', 'surface', 'hp', 'lenovo')),
  applicability varchar(16) NOT NULL
    CONSTRAINT device_oem_update_status_applicability_chk
    CHECK (applicability IN ('applicable', 'not_applicable', 'not_supported')),
  -- Why the device is not applicable (a closed code from resolveApplicability).
  reason varchar(48),
  tool_version varchar(64),
  occurrence_key varchar(64),
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_outcome varchar(32)
    CONSTRAINT device_oem_update_status_last_outcome_chk
    CHECK (last_outcome IS NULL OR last_outcome IN (
      'success', 'success_reboot_required', 'no_updates', 'partial', 'failed',
      'not_supported', 'tool_unavailable', 'blocked_on_battery',
      'blocked_reboot_pending', 'blocked_no_recovery_key', 'retry_later', 'interrupted'
    )),
  -- result.errorCode of the last run, or `result_unparseable` from the API.
  last_error_code varchar(64),
  last_command_id uuid,
  installed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  reboot_required boolean NOT NULL DEFAULT false,
  -- device_hardware.bios_version is varchar(100).
  bios_version_before varchar(100),
  bios_version_after varchar(100),
  -- Set once, by the first result that reached the vendor tool's answer.
  first_completed_at timestamptz,
  -- The not-returned monitor: set at dispatch for a bios or firmware run,
  -- cleared once the device shows it came back.
  run_started_at timestamptz,
  return_deadline_at timestamptz,
  not_returned_alerted_at timestamptz,
  reboot_pending_since timestamptz,
  takeover_state varchar(16) NOT NULL DEFAULT 'none'
    CONSTRAINT device_oem_update_status_takeover_state_chk
    CHECK (takeover_state IN ('none', 'taken_over', 'policy_locked', 'releasing')),
  -- applicability = 'not_supported' is sticky to these two: a new tool version
  -- or a different model is a new question (spec 4.3).
  not_supported_tool_version varchar(64),
  not_supported_model varchar(255),
  bitlocker_after varchar(16)
    CONSTRAINT device_oem_update_status_bitlocker_after_chk
    CHECK (bitlocker_after IS NULL OR bitlocker_after IN ('on', 'suspended', 'off', 'unknown')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Composite (device_id, org_id) FK: a row can only name a device of the org it
-- claims. ON UPDATE CASCADE restamps org_id when the device moves orgs
-- (DEVICE_ORG_FK_CASCADE_TABLES in routes/devices/core.ts); ON DELETE CASCADE
-- removes the row with the device. DEFERRABLE INITIALLY IMMEDIATE is mandatory
-- for composite FKs on org_id (org merge runs SET CONSTRAINTS ALL DEFERRED).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_oem_update_status_device_org_fk'
  ) THEN
    ALTER TABLE device_oem_update_status
      ADD CONSTRAINT device_oem_update_status_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_oem_update_status_device_uidx
  ON device_oem_update_status (device_id);
CREATE INDEX IF NOT EXISTS device_oem_update_status_org_applicability_idx
  ON device_oem_update_status (org_id, applicability);
CREATE INDEX IF NOT EXISTS device_oem_update_status_return_deadline_idx
  ON device_oem_update_status (return_deadline_at)
  WHERE return_deadline_at IS NOT NULL;

-- RLS shape 1 (direct NOT NULL org_id). breeze_has_org_access already grants
-- system scope, so there is no separate system branch.
ALTER TABLE device_oem_update_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_oem_update_status FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_oem_update_status;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_oem_update_status;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_oem_update_status;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_oem_update_status;

CREATE POLICY breeze_org_isolation_select ON device_oem_update_status
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_oem_update_status
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_oem_update_status
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_oem_update_status
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON device_oem_update_status TO breeze_app;
