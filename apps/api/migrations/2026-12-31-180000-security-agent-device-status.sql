-- security_agent_device_status (#6960, feature #8734 W03 #8737): persisted
-- per-(device, vendor) coverage state for managed security agents.
--
-- Derived, observed state -- NOT config. The compliance worker writes
-- `not_applicable` (+ readiness reason) for devices a managed security-agent
-- policy reaches but the vendor cannot serve, and clears it to `pending` on
-- recovery. The coverage reconciler (jobs/securityAgentCoverageWorker.ts)
-- classifies the rest (covered / gap / vendor_offline / mismatched_org /
-- pending) and writes `vendor_only` rows for vendor-reported agents that no
-- Breeze device matches. Gap and mismatch TRANSITIONS raise alerts, so the
-- prior state stored here is load-bearing.
--
-- Tenancy: `org_id NOT NULL` is the DEVICE's org (never the policy owner's),
-- like edr_endpoints. The dual-axis part lives on software_policies, which
-- this table only points at. RLS shape 1 (direct org_id).
--
-- No json/jsonb/bytea column: every column classifies `included` in
-- CORE_TENANT_EXPORT_POLICY. `detail` is plain operator-facing text and never
-- carries another tenant's names (mismatch detail is generic by design).
--
-- No rows are written here, so no system-scope election is needed.

CREATE TABLE IF NOT EXISTS security_agent_device_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL only for `vendor_only` rows (a vendor agent no Breeze device matches).
  device_id uuid,
  -- Breeze-side id of the vendor endpoint row (huntress_agents.id today;
  -- s1_agents / edr_endpoints ids in later waves). Text so every source fits.
  vendor_endpoint_id varchar(128),
  vendor varchar(32) NOT NULL
    CONSTRAINT security_agent_device_status_vendor_chk
    CHECK (vendor IN ('huntress', 'sentinelone', 'controld', 'nextdns')),
  state varchar(24) NOT NULL
    CONSTRAINT security_agent_device_status_state_chk
    CHECK (state IN ('covered', 'gap', 'vendor_only', 'vendor_offline', 'mismatched_org', 'not_applicable', 'pending')),
  reason_code varchar(48),
  detail text,
  -- The generated (managed) software policy that put the device in scope.
  -- SET NULL so deleting a config policy (which cascades its link, then the
  -- generated policy) never fails on status rows; the reconciler prunes them.
  policy_id uuid REFERENCES software_policies(id) ON DELETE SET NULL,
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  -- When `state` last changed: "gap since …" in the UI.
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A device row is never vendor_only; a vendor_only row always names its endpoint.
  CONSTRAINT security_agent_device_status_shape_chk CHECK (
    (device_id IS NULL) = (state = 'vendor_only')
    AND (device_id IS NOT NULL OR vendor_endpoint_id IS NOT NULL)
  )
);

-- Composite (device_id, org_id) FK (pattern: device_restore_point_attempts):
-- a row can only name a device of the org it claims. ON UPDATE CASCADE restamps
-- org_id when the device moves orgs (DEVICE_ORG_FK_CASCADE_TABLES in
-- routes/devices/core.ts); ON DELETE CASCADE removes rows with the device.
-- MATCH SIMPLE: vendor_only rows (device_id NULL) are not checked.
-- DEFERRABLE INITIALLY IMMEDIATE is mandatory for composite FKs on org_id (org
-- merge runs SET CONSTRAINTS ALL DEFERRED).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'security_agent_device_status_device_org_fk'
  ) THEN
    ALTER TABLE security_agent_device_status
      ADD CONSTRAINT security_agent_device_status_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- One row per (device, vendor); one vendor_only row per (org, vendor, endpoint).
CREATE UNIQUE INDEX IF NOT EXISTS security_agent_device_status_device_vendor_uidx
  ON security_agent_device_status (device_id, vendor)
  WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS security_agent_device_status_vendor_only_uidx
  ON security_agent_device_status (org_id, vendor, vendor_endpoint_id)
  WHERE device_id IS NULL;
CREATE INDEX IF NOT EXISTS security_agent_device_status_org_state_idx
  ON security_agent_device_status (org_id, vendor, state);
CREATE INDEX IF NOT EXISTS security_agent_device_status_policy_idx
  ON security_agent_device_status (policy_id)
  WHERE policy_id IS NOT NULL;

-- RLS shape 1 (direct NOT NULL org_id). breeze_has_org_access already grants
-- system scope, so there is no separate system branch.
ALTER TABLE security_agent_device_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_agent_device_status FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON security_agent_device_status;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON security_agent_device_status;
DROP POLICY IF EXISTS breeze_org_isolation_update ON security_agent_device_status;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON security_agent_device_status;

CREATE POLICY breeze_org_isolation_select ON security_agent_device_status
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON security_agent_device_status
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON security_agent_device_status
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON security_agent_device_status
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON security_agent_device_status TO breeze_app;
