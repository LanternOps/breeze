-- Manual software-remediation authorization records (#3553).
--
-- A `software_remediation` job's `trigger: 'manual'` is authorization state:
-- the worker skips the arming gate (enforceMode/autoUninstall) when it is set.
-- That flag rides in BullMQ job data, which lives in Redis with no
-- authentication of its own — anything with Redis write access could enqueue a
-- forged `{trigger:'manual'}` job and drive uninstalls on an unarmed policy.
--
-- This table is the durable, single-use proof that the MFA-gated remediate route
-- actually authorized a specific (policy, device) uninstall. The route creates
-- one row per device it schedules and puts the row id in the job data; the
-- worker consumes the row atomically and refuses to honor `manual` without a
-- matching, unconsumed, unexpired, ownership-coherent row (it falls back to the
-- `auto` arming gate — fail-closed).
--
-- Tenancy: DUAL-AXIS (org_id set from the DEVICE's org, partner_id from the
-- policy's partner), mirroring software_policy_audit. Registered in
-- DUAL_AXIS_TENANT_TABLES so the RLS coverage contract test asserts BOTH the
-- breeze_has_org_access (auto-discovered via org_id) and breeze_has_partner_access
-- branches. RLS enabled AND forced with dual-axis policies in THIS migration.
--
-- device_id + org_id columns: the generic device-move trigger
-- (breeze_cascade_device_org_id, 2026-05-18) rewrites org_id when a member
-- device changes orgs. That is fine here BECAUSE the worker's consume re-joins
-- the CURRENT device + policy and requires ownership coherence, so a request
-- whose device moved orgs no longer matches and is refused. RLS is row-visibility
-- only; it is not the integrity boundary — the consume join is.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded DO blocks, CREATE INDEX IF NOT
-- EXISTS, DROP POLICY IF EXISTS before each CREATE POLICY. gen_random_uuid() only.

CREATE TABLE IF NOT EXISTS software_remediation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES software_policies(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

-- At least one tenancy axis, mirroring software_policy_audit_owner_chk. org_id is
-- always set in practice (the device always has an org); partner_id is set when
-- the policy is partner-wide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_remediation_requests_owner_chk'
      AND conrelid = 'software_remediation_requests'::regclass
  ) THEN
    ALTER TABLE software_remediation_requests
      ADD CONSTRAINT software_remediation_requests_owner_chk
      CHECK (org_id IS NOT NULL OR partner_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_remediation_requests_org_id_idx ON software_remediation_requests (org_id);
CREATE INDEX IF NOT EXISTS software_remediation_requests_partner_id_idx ON software_remediation_requests (partner_id);
CREATE INDEX IF NOT EXISTS software_remediation_requests_policy_id_idx ON software_remediation_requests (policy_id);
CREATE INDEX IF NOT EXISTS software_remediation_requests_device_id_idx ON software_remediation_requests (device_id);
-- expires_at index: rows are short-lived single-use tokens. There is no
-- dedicated sweeper job yet; unconsumed rows simply expire (the consume requires
-- expires_at > now) and are cascade-deleted when their device/policy is removed.
-- The index keeps a future prune (or an expiry-filtered query) cheap.
CREATE INDEX IF NOT EXISTS software_remediation_requests_expiry_idx ON software_remediation_requests (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE software_remediation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_remediation_requests FORCE ROW LEVEL SECURITY;

-- Dual-axis policies (breeze_has_org_access short-circuits TRUE in system scope,
-- so the worker's system-context consume passes without a special clause).
DROP POLICY IF EXISTS breeze_srr_isolation_select ON software_remediation_requests;
DROP POLICY IF EXISTS breeze_srr_isolation_insert ON software_remediation_requests;
DROP POLICY IF EXISTS breeze_srr_isolation_update ON software_remediation_requests;
DROP POLICY IF EXISTS breeze_srr_isolation_delete ON software_remediation_requests;

CREATE POLICY breeze_srr_isolation_select ON software_remediation_requests
  FOR SELECT USING (
    public.breeze_has_partner_access(partner_id) OR public.breeze_has_org_access(org_id)
  );
CREATE POLICY breeze_srr_isolation_insert ON software_remediation_requests
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id) OR public.breeze_has_org_access(org_id)
  );
CREATE POLICY breeze_srr_isolation_update ON software_remediation_requests
  FOR UPDATE USING (
    public.breeze_has_partner_access(partner_id) OR public.breeze_has_org_access(org_id)
  )
  WITH CHECK (
    public.breeze_has_partner_access(partner_id) OR public.breeze_has_org_access(org_id)
  );
CREATE POLICY breeze_srr_isolation_delete ON software_remediation_requests
  FOR DELETE USING (
    public.breeze_has_partner_access(partner_id) OR public.breeze_has_org_access(org_id)
  );
