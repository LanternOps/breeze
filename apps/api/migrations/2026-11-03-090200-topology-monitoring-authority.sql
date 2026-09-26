-- Topology M3 Task 7 (amendments M3-D2/D3/D4/D8): human-only arming of site
-- policies and standing interface telemetry.
--
-- 1. topology_monitoring_policies gains the site-local arm: the typed frozen
--    actor (auth/MFA epochs, narrowed org/site ceilings), the permission
--    authority version, the arm time, the routing contexts bound to the
--    source/interface generations observed at arm time, and the bounded
--    runtime alert/streak state with its own CAS revision. The portable
--    `definition` (template payload) is untouched.
-- 2. topology_telemetry_arms: one standing SNMP interface-telemetry arm per
--    target authority, OUTSIDE the settings digest so settings writes never
--    touch it. Shape 1 (direct org_id) RLS; registered in the org cascade,
--    merge and export registries in the same change.
--
-- Schema only; no rows are written, so no system-scope elevation is needed.

ALTER TABLE topology_monitoring_policies ADD COLUMN IF NOT EXISTS authority_actor jsonb;
ALTER TABLE topology_monitoring_policies ADD COLUMN IF NOT EXISTS authority_permission_version varchar(256);
ALTER TABLE topology_monitoring_policies ADD COLUMN IF NOT EXISTS armed_at timestamptz;
ALTER TABLE topology_monitoring_policies ADD COLUMN IF NOT EXISTS routing_contexts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE topology_monitoring_policies ADD COLUMN IF NOT EXISTS alert_state jsonb NOT NULL DEFAULT '{"schemaVersion":1,"entries":[]}'::jsonb;
ALTER TABLE topology_monitoring_policies ADD COLUMN IF NOT EXISTS alert_state_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_authority_actor_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_authority_actor_chk
  CHECK (authority_actor IS NULL OR (jsonb_typeof(authority_actor) = 'object' AND octet_length(authority_actor::text) <= 16384));
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_routing_contexts_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_routing_contexts_chk
  CHECK (jsonb_typeof(routing_contexts) = 'array' AND jsonb_array_length(routing_contexts) <= 256 AND octet_length(routing_contexts::text) <= 65536);
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_alert_state_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_alert_state_chk
  CHECK (jsonb_typeof(alert_state) = 'object' AND alert_state->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof(alert_state->'entries') = 'array' AND jsonb_array_length(alert_state->'entries') <= 256
    AND octet_length(alert_state::text) <= 262144);
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_alert_state_revision_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_alert_state_revision_chk CHECK (alert_state_revision >= 0);
-- An enabled (armed) policy always carries its complete authority.
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_armed_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_armed_chk
  CHECK (NOT enabled OR (authority_actor IS NOT NULL AND authority_permission_version IS NOT NULL AND armed_at IS NOT NULL
    AND requester_id IS NOT NULL AND jsonb_array_length(routing_contexts) > 0));
-- Direct writes cannot smuggle an unknown/duplicate alert entry past the app validator.
CREATE OR REPLACE FUNCTION breeze_topology_policy_alert_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry jsonb;
  pairs text[] := ARRAY[]::text[];
  pair text;
  allowed text[] := ARRAY['contextKey','family','policyRevision','lastClaimedScheduledFor','lastClaimedOccurrenceKey',
    'lastAppliedScheduledFor','lastAppliedOccurrenceKey','continuityKey','originDeviceId','originAgentId',
    'consecutiveFailures','consecutiveSuccesses','activeAlertId','lastNotifiedAt'];
BEGIN
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.alert_state->'entries') LOOP
    IF jsonb_typeof(entry) <> 'object' OR NOT (SELECT bool_and(k = ANY(allowed)) FROM jsonb_object_keys(entry) AS k)
      OR entry->>'family' NOT IN ('ipv4','ipv6') OR coalesce(entry->>'contextKey','') = ''
      OR jsonb_typeof(entry->'consecutiveFailures') <> 'number' OR (entry->>'consecutiveFailures')::numeric < 0
      OR jsonb_typeof(entry->'consecutiveSuccesses') <> 'number' OR (entry->>'consecutiveSuccesses')::numeric < 0 THEN
      RAISE EXCEPTION 'malformed topology policy alert state entry' USING ERRCODE = '23514';
    END IF;
    pair := (entry->>'contextKey') || chr(1) || (entry->>'family');
    IF pair = ANY(pairs) THEN
      RAISE EXCEPTION 'duplicate topology policy alert state entry' USING ERRCODE = '23514';
    END IF;
    pairs := pairs || pair;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_policy_alert_state_guard ON topology_monitoring_policies;
CREATE TRIGGER breeze_topology_policy_alert_state_guard BEFORE INSERT OR UPDATE OF alert_state ON topology_monitoring_policies
  FOR EACH ROW EXECUTE FUNCTION breeze_topology_policy_alert_state_guard();

CREATE TABLE IF NOT EXISTS topology_telemetry_arms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  producer_kind varchar(16) NOT NULL DEFAULT 'snmp',
  target_node_id uuid NOT NULL,
  collector_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  credential_profile_id uuid NOT NULL REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  authority_key varchar(255) NOT NULL,
  target_address varchar(64) NOT NULL,
  credential_digest varchar(64) NOT NULL,
  interfaces jsonb NOT NULL,
  interval_seconds integer NOT NULL DEFAULT 60,
  state varchar(16) NOT NULL DEFAULT 'armed',
  blocked_reason varchar(64),
  generation bigint NOT NULL DEFAULT 1,
  armed_by uuid NOT NULL,
  authority_actor jsonb NOT NULL,
  authority_permission_version varchar(256) NOT NULL,
  effect_digest varchar(64) NOT NULL,
  armed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  next_poll_at timestamptz,
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_telemetry_arms_site_fk FOREIGN KEY (site_id, org_id) REFERENCES sites(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_telemetry_arms_target_node_fk FOREIGN KEY (target_node_id, org_id, site_id) REFERENCES topology_nodes(id, org_id, site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_telemetry_arms_kind_chk CHECK (producer_kind IN ('snmp')),
  CONSTRAINT topology_telemetry_arms_state_chk CHECK (state IN ('armed','revoked','blocked')),
  CONSTRAINT topology_telemetry_arms_interval_chk CHECK (interval_seconds BETWEEN 30 AND 300),
  CONSTRAINT topology_telemetry_arms_generation_chk CHECK (generation >= 1),
  CONSTRAINT topology_telemetry_arms_authority_key_chk CHECK (authority_key LIKE 'snmp:%' AND char_length(authority_key) > 5),
  CONSTRAINT topology_telemetry_arms_digests_chk CHECK (credential_digest ~ '^[a-f0-9]{64}$' AND effect_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT topology_telemetry_arms_interfaces_chk CHECK (jsonb_typeof(interfaces) = 'array' AND jsonb_array_length(interfaces) BETWEEN 1 AND 256 AND octet_length(interfaces::text) <= 65536),
  CONSTRAINT topology_telemetry_arms_actor_chk CHECK (jsonb_typeof(authority_actor) = 'object' AND octet_length(authority_actor::text) <= 16384),
  CONSTRAINT topology_telemetry_arms_expiry_chk CHECK (expires_at > armed_at),
  CONSTRAINT topology_telemetry_arms_revoked_chk CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_telemetry_arms_id_org_site_uniq ON topology_telemetry_arms(id, org_id, site_id);
-- One live arm per target authority: a second arm for the same switch replaces, never races.
CREATE UNIQUE INDEX IF NOT EXISTS topology_telemetry_arms_live_uniq ON topology_telemetry_arms(org_id, site_id, producer_kind, authority_key)
  WHERE state = 'armed';
CREATE INDEX IF NOT EXISTS topology_telemetry_arms_due_idx ON topology_telemetry_arms(next_poll_at) WHERE state = 'armed';
CREATE INDEX IF NOT EXISTS topology_telemetry_arms_collector_idx ON topology_telemetry_arms(collector_device_id);
CREATE INDEX IF NOT EXISTS topology_telemetry_arms_profile_idx ON topology_telemetry_arms(credential_profile_id);

ALTER TABLE topology_telemetry_arms ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_telemetry_arms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_telemetry_arms;
CREATE POLICY tenant_isolation ON topology_telemetry_arms USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_telemetry_arms TO breeze_app;

-- 3. Scheduled occurrences on topology_diagnostic_runs (M3-D11/D14). All seven
--    columns are NULL for an on-demand run and all present for a scheduled one;
--    the partial unique index is the cross-replica occurrence claim, and the
--    idempotency key (the occurrence key) is a second guard. A scheduled run
--    always carries the frozen requester authority (M3-D13).
-- requester_authority is also created (with its CHECK/guard) by the M3 Task 9
-- migration 2026-11-03-090500, which sorts AFTER this one; declared here too
-- (idempotently) so this file's CHECK does not depend on a later migration.
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS requester_authority jsonb;
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS policy_id uuid;
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS policy_revision bigint;
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS scheduled_context_key text;
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS scheduled_family text;
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS occurrence_key text;
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS continuity_key text;
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_occurrence_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_occurrence_chk CHECK (
  num_nonnulls(policy_id, policy_revision, scheduled_context_key, scheduled_family, scheduled_for, occurrence_key, continuity_key) IN (0, 7)
  AND (policy_id IS NULL OR (
    scheduled_family IN ('ipv4','ipv6') AND octet_length(scheduled_context_key) BETWEEN 1 AND 255 AND policy_revision >= 0
    AND occurrence_key ~ '^[a-f0-9]{64}$' AND continuity_key ~ '^[a-f0-9]{64}$' AND requester_authority IS NOT NULL
    AND recipe_id <> 'trace_route')));
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_policy_fk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_policy_fk FOREIGN KEY (policy_id, org_id, site_id)
  REFERENCES topology_monitoring_policies(id, org_id, site_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
CREATE UNIQUE INDEX IF NOT EXISTS topology_diagnostic_runs_occurrence_uniq
  ON topology_diagnostic_runs(org_id, site_id, policy_id, scheduled_context_key, scheduled_family, scheduled_for) WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS topology_diagnostic_runs_policy_idx ON topology_diagnostic_runs(policy_id, scheduled_for DESC) WHERE policy_id IS NOT NULL;
