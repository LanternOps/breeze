-- Durable rollback projection plus immutable phase evidence. Kept separate
-- from 2026-09-12 so an already-applied permission migration is never edited.
CREATE TABLE IF NOT EXISTS agent_rollback_directives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  platform varchar(16) NOT NULL CHECK (platform IN ('windows', 'macos', 'linux')),
  architecture varchar(16) NOT NULL CHECK (architecture IN ('amd64', 'arm64')),
  current_version varchar(100) NOT NULL,
  target_version varchar(100) NOT NULL,
  component_versions jsonb NOT NULL CHECK (jsonb_typeof(component_versions) = 'object'),
  release_manifest text NOT NULL,
  manifest_signature text NOT NULL,
  manifest_signing_key_id varchar(255) NOT NULL,
  artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts) = 'array'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  authorized_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  directive_signing_key_id varchar(255) NOT NULL,
  directive_signature text NOT NULL,
  command_id uuid REFERENCES device_commands(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'in_progress', 'completed', 'failed', 'recovered', 'expired')),
  latest_phase varchar(32)
    CHECK (latest_phase IS NULL OR latest_phase IN ('received', 'downloaded', 'verified', 'staged', 'swapped', 'restart_requested', 'healthy', 'failed', 'recovered')),
  last_error_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_rollback_directives_identity_uq UNIQUE (id, device_id, org_id),
  CONSTRAINT agent_rollback_directives_device_org_fk
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_rollback_directives_expiry_chk CHECK (expires_at > approved_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_rollback_directives_active_device_uq
  ON agent_rollback_directives (device_id)
  WHERE status IN ('requested', 'in_progress');
CREATE INDEX IF NOT EXISTS agent_rollback_directives_org_created_idx
  ON agent_rollback_directives (org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_rollback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rollback_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  phase varchar(32) NOT NULL
    CHECK (phase IN ('received', 'downloaded', 'verified', 'staged', 'swapped', 'restart_requested', 'healthy', 'failed', 'recovered')),
  observation_id varchar(255) NOT NULL,
  observed_at timestamptz NOT NULL,
  current_version varchar(100) NOT NULL,
  component_versions jsonb NOT NULL CHECK (jsonb_typeof(component_versions) = 'object'),
  error_code varchar(128),
  observation jsonb NOT NULL CHECK (jsonb_typeof(observation) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_rollback_events_device_org_fk
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_rollback_events_rollback_identity_fk
    FOREIGN KEY (rollback_id, device_id, org_id)
    REFERENCES agent_rollback_directives(id, device_id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_rollback_events_observation_uq UNIQUE (rollback_id, observation_id)
);

CREATE INDEX IF NOT EXISTS agent_rollback_events_org_time_idx
  ON agent_rollback_events (org_id, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_rollback_events_rollback_time_idx
  ON agent_rollback_events (rollback_id, observed_at DESC, id DESC);

ALTER TABLE agent_rollback_directives ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_rollback_directives FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_rollback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_rollback_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON agent_rollback_directives;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON agent_rollback_directives;
DROP POLICY IF EXISTS breeze_org_isolation_update ON agent_rollback_directives;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON agent_rollback_directives;
CREATE POLICY breeze_org_isolation_select ON agent_rollback_directives
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON agent_rollback_directives
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON agent_rollback_directives
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON agent_rollback_directives
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON agent_rollback_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON agent_rollback_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON agent_rollback_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON agent_rollback_events;
CREATE POLICY breeze_org_isolation_select ON agent_rollback_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON agent_rollback_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON agent_rollback_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON agent_rollback_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON agent_rollback_directives TO breeze_app;
GRANT SELECT, INSERT, REFERENCES ON agent_rollback_events TO breeze_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agent_rollback_events FROM breeze_app;
GRANT SELECT, DELETE ON agent_rollback_events TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON agent_rollback_events FROM breeze_audit_admin;

CREATE OR REPLACE FUNCTION agent_rollback_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF allow_retention = '1' OR pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'org_id') = (to_jsonb(OLD) - 'org_id')
       AND EXISTS (SELECT 1 FROM devices WHERE id = NEW.device_id AND org_id = NEW.org_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'agent rollback events are append-only',
    HINT = 'Retention uses breeze_audit_admin plus breeze.allow_audit_retention=1.';
END;
$$;

DROP TRIGGER IF EXISTS agent_rollback_events_block_update ON agent_rollback_events;
CREATE TRIGGER agent_rollback_events_block_update
  BEFORE UPDATE ON agent_rollback_events
  FOR EACH ROW EXECUTE FUNCTION agent_rollback_events_append_only();
DROP TRIGGER IF EXISTS agent_rollback_events_block_delete ON agent_rollback_events;
CREATE TRIGGER agent_rollback_events_block_delete
  BEFORE DELETE ON agent_rollback_events
  FOR EACH ROW EXECUTE FUNCTION agent_rollback_events_append_only();
