-- Retain every software inventory report as tenant-scoped evidence while
-- keeping software_inventory as the last-known-good projection.

CREATE TABLE IF NOT EXISTS software_inventory_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  schema_version integer NOT NULL,
  collector_version varchar(64) NOT NULL,
  agent_version varchar(64),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  completeness varchar(16) NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  claimed_item_count integer NOT NULL,
  actual_item_count integer NOT NULL,
  expected_sources jsonb NOT NULL,
  succeeded_sources jsonb NOT NULL,
  failed_sources jsonb NOT NULL,
  items jsonb NOT NULL,
  report_digest varchar(64) NOT NULL,
  accepted_for_inventory boolean NOT NULL,
  absence_resolution_eligible boolean NOT NULL,
  reason_code varchar(64) NOT NULL,
  visible_item_count integer NOT NULL,
  CONSTRAINT software_inventory_observations_counts_chk
    CHECK (claimed_item_count >= 0 AND actual_item_count >= 0 AND visible_item_count >= 0),
  CONSTRAINT software_inventory_observations_schema_version_chk
    CHECK (schema_version IN (1, 2)),
  CONSTRAINT software_inventory_observations_completeness_chk
    CHECK (completeness IN ('complete', 'partial', 'failed')),
  CONSTRAINT software_inventory_observations_device_org_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS software_inventory_observations_identity_owner_uq
  ON software_inventory_observations(id, org_id, device_id);
CREATE INDEX IF NOT EXISTS software_inventory_observations_device_received_idx
  ON software_inventory_observations(device_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS software_inventory_observations_org_received_idx
  ON software_inventory_observations(org_id, received_at DESC);

CREATE TABLE IF NOT EXISTS device_software_inventory_state (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  latest_observation_id uuid,
  latest_accepted_observation_id uuid,
  visible_observation_id uuid,
  has_accepted_v2 boolean NOT NULL DEFAULT false,
  visible_item_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_software_inventory_state_visible_count_chk CHECK (visible_item_count >= 0),
  CONSTRAINT device_software_inventory_state_device_org_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT device_software_inventory_state_latest_owner_fkey
    FOREIGN KEY (latest_observation_id, org_id, device_id)
    REFERENCES software_inventory_observations(id, org_id, device_id)
    ON DELETE SET NULL (latest_observation_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT device_software_inventory_state_accepted_owner_fkey
    FOREIGN KEY (latest_accepted_observation_id, org_id, device_id)
    REFERENCES software_inventory_observations(id, org_id, device_id)
    ON DELETE SET NULL (latest_accepted_observation_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT device_software_inventory_state_visible_owner_fkey
    FOREIGN KEY (visible_observation_id, org_id, device_id)
    REFERENCES software_inventory_observations(id, org_id, device_id)
    ON DELETE SET NULL (visible_observation_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS device_software_inventory_state_org_idx
  ON device_software_inventory_state(org_id);
CREATE INDEX IF NOT EXISTS device_software_inventory_state_latest_accepted_idx
  ON device_software_inventory_state(latest_accepted_observation_id)
  WHERE latest_accepted_observation_id IS NOT NULL;

ALTER TABLE software_inventory ADD COLUMN IF NOT EXISTS observation_id uuid;
CREATE INDEX IF NOT EXISTS software_inventory_observation_id_idx
  ON software_inventory(observation_id) WHERE observation_id IS NOT NULL;
ALTER TABLE software_inventory
  DROP CONSTRAINT IF EXISTS software_inventory_observation_owner_fkey;
ALTER TABLE software_inventory
  ADD CONSTRAINT software_inventory_observation_owner_fkey
  FOREIGN KEY (observation_id, org_id, device_id)
  REFERENCES software_inventory_observations(id, org_id, device_id)
  ON DELETE SET NULL (observation_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE device_vulnerabilities ADD COLUMN IF NOT EXISTS resolved_observation_id uuid;
CREATE INDEX IF NOT EXISTS device_vuln_resolved_observation_idx
  ON device_vulnerabilities(resolved_observation_id)
  WHERE resolved_observation_id IS NOT NULL;
ALTER TABLE device_vulnerabilities
  DROP CONSTRAINT IF EXISTS device_vulnerabilities_resolved_observation_owner_fkey;
ALTER TABLE device_vulnerabilities
  ADD CONSTRAINT device_vulnerabilities_resolved_observation_owner_fkey
  FOREIGN KEY (resolved_observation_id, org_id, device_id)
  REFERENCES software_inventory_observations(id, org_id, device_id)
  ON DELETE SET NULL (resolved_observation_id) DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION software_inventory_observations_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The device move contract may restamp tenant metadata. Every identity,
  -- payload, receipt, decision, and lineage fact remains immutable.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.collector_version IS DISTINCT FROM OLD.collector_version
     OR NEW.agent_version IS DISTINCT FROM OLD.agent_version
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.completeness IS DISTINCT FROM OLD.completeness
     OR NEW.truncated IS DISTINCT FROM OLD.truncated
     OR NEW.claimed_item_count IS DISTINCT FROM OLD.claimed_item_count
     OR NEW.actual_item_count IS DISTINCT FROM OLD.actual_item_count
     OR NEW.expected_sources IS DISTINCT FROM OLD.expected_sources
     OR NEW.succeeded_sources IS DISTINCT FROM OLD.succeeded_sources
     OR NEW.failed_sources IS DISTINCT FROM OLD.failed_sources
     OR NEW.items IS DISTINCT FROM OLD.items
     OR NEW.report_digest IS DISTINCT FROM OLD.report_digest
     OR NEW.accepted_for_inventory IS DISTINCT FROM OLD.accepted_for_inventory
     OR NEW.absence_resolution_eligible IS DISTINCT FROM OLD.absence_resolution_eligible
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.visible_item_count IS DISTINCT FROM OLD.visible_item_count THEN
    RAISE EXCEPTION 'software inventory observation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS software_inventory_observations_immutable_trg
  ON software_inventory_observations;
CREATE TRIGGER software_inventory_observations_immutable_trg
  BEFORE UPDATE ON software_inventory_observations
  FOR EACH ROW EXECUTE FUNCTION software_inventory_observations_immutable_guard();

ALTER TABLE software_inventory_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_inventory_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE device_software_inventory_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_software_inventory_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_inventory_observations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_inventory_observations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_inventory_observations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_inventory_observations;
CREATE POLICY breeze_org_isolation_select ON software_inventory_observations FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON software_inventory_observations FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON software_inventory_observations FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON software_inventory_observations FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_software_inventory_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_software_inventory_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_software_inventory_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_software_inventory_state;
CREATE POLICY breeze_org_isolation_select ON device_software_inventory_state FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_software_inventory_state FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_software_inventory_state FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_software_inventory_state FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, DELETE, REFERENCES ON software_inventory_observations TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON device_software_inventory_state TO breeze_app;
-- Evidence rows are immutable apart from trusted tenant restamping. The RLS
-- UPDATE policy and trigger remain structural defenses, while this privilege
-- boundary keeps the app role from issuing direct evidence updates or truncates.
REVOKE UPDATE, TRUNCATE ON software_inventory_observations FROM breeze_app;
REVOKE TRUNCATE ON device_software_inventory_state FROM breeze_app;
REVOKE TRUNCATE ON software_inventory_observations, device_software_inventory_state FROM PUBLIC;
