-- Versioned agent self-health evidence. Reachability remains on devices.status;
-- these tables record an independent, immutable observation stream and one
-- compare-and-set latest projection.

CREATE TABLE IF NOT EXISTS agent_health_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  schema_version integer NOT NULL,
  agent_version varchar(64) NOT NULL,
  overall varchar(16) NOT NULL,
  metrics_available boolean,
  components jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_health_observations_device_observed_uq
  ON agent_health_observations(device_id, observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_health_observations_identity_owner_uq
  ON agent_health_observations(id, org_id, device_id);
CREATE INDEX IF NOT EXISTS agent_health_observations_device_received_idx
  ON agent_health_observations(device_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_health_observations_org_idx
  ON agent_health_observations(org_id);

ALTER TABLE agent_health_observations
  DROP CONSTRAINT IF EXISTS agent_health_observations_device_org_fkey;
ALTER TABLE agent_health_observations
  ADD CONSTRAINT agent_health_observations_device_org_fkey
  FOREIGN KEY (device_id, org_id)
  REFERENCES devices(id, org_id)
  ON UPDATE CASCADE ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE agent_health_observations
  DROP CONSTRAINT IF EXISTS agent_health_observations_schema_version_chk;
ALTER TABLE agent_health_observations
  ADD CONSTRAINT agent_health_observations_schema_version_chk
  CHECK (schema_version > 0);

ALTER TABLE agent_health_observations
  DROP CONSTRAINT IF EXISTS agent_health_observations_overall_chk;
ALTER TABLE agent_health_observations
  ADD CONSTRAINT agent_health_observations_overall_chk
  CHECK (overall IN ('healthy', 'warning', 'error', 'unknown'));

CREATE TABLE IF NOT EXISTS device_agent_health_latest (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_agent_health_latest_org_idx
  ON device_agent_health_latest(org_id);
CREATE INDEX IF NOT EXISTS device_agent_health_latest_received_idx
  ON device_agent_health_latest(received_at DESC);

ALTER TABLE device_agent_health_latest
  DROP CONSTRAINT IF EXISTS device_agent_health_latest_device_org_fkey;
ALTER TABLE device_agent_health_latest
  ADD CONSTRAINT device_agent_health_latest_device_org_fkey
  FOREIGN KEY (device_id, org_id)
  REFERENCES devices(id, org_id)
  ON UPDATE CASCADE ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE device_agent_health_latest
  DROP CONSTRAINT IF EXISTS device_agent_health_latest_observation_owner_fkey;
ALTER TABLE device_agent_health_latest
  ADD CONSTRAINT device_agent_health_latest_observation_owner_fkey
  FOREIGN KEY (observation_id, org_id, device_id)
  REFERENCES agent_health_observations(id, org_id, device_id)
  ON UPDATE CASCADE ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION agent_health_observations_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- org_id is tenancy metadata and may change only as part of the existing
  -- device move/restamp contract. Every producer-provided evidence field and
  -- both timestamps remain immutable.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.agent_version IS DISTINCT FROM OLD.agent_version
     OR NEW.overall IS DISTINCT FROM OLD.overall
     OR NEW.metrics_available IS DISTINCT FROM OLD.metrics_available
     OR NEW.components IS DISTINCT FROM OLD.components
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'agent health observation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_health_observations_immutable_trg
  ON agent_health_observations;
CREATE TRIGGER agent_health_observations_immutable_trg
  BEFORE UPDATE ON agent_health_observations
  FOR EACH ROW EXECUTE FUNCTION agent_health_observations_immutable_guard();

ALTER TABLE agent_health_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_health_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE device_agent_health_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_agent_health_latest FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON agent_health_observations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON agent_health_observations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON agent_health_observations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON agent_health_observations;
CREATE POLICY breeze_org_isolation_select ON agent_health_observations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON agent_health_observations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON agent_health_observations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON agent_health_observations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_agent_health_latest;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_agent_health_latest;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_agent_health_latest;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_agent_health_latest;
CREATE POLICY breeze_org_isolation_select ON device_agent_health_latest
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_agent_health_latest
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_agent_health_latest
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_agent_health_latest
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, DELETE, REFERENCES ON agent_health_observations TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON device_agent_health_latest TO breeze_app;
REVOKE UPDATE, TRUNCATE ON agent_health_observations FROM breeze_app;
REVOKE TRUNCATE ON agent_health_observations FROM PUBLIC;
