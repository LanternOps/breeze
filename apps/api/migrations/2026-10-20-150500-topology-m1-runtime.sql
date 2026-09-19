-- Site-bound execution rows are distinct from reusable partner-wide monitor configuration.
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS site_id uuid;
-- FORCE RLS binds the migration role; without system scope the backfill matches zero rows.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n bigint; BEGIN
 UPDATE network_monitors m SET site_id = a.site_id FROM discovered_assets a
 WHERE m.asset_id = a.id AND m.org_id = a.org_id AND m.site_id IS NULL;
 GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'topology monitor site backfill: % rows', n;
 UPDATE network_monitors SET is_active = false, asset_id = NULL
 WHERE asset_id IS NOT NULL AND (site_id IS NULL OR NOT EXISTS (
 SELECT 1 FROM discovered_assets a WHERE a.id = network_monitors.asset_id AND a.org_id = network_monitors.org_id AND a.site_id = network_monitors.site_id));
 GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'topology invalid monitor associations disabled: % rows', n;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS network_monitors_id_org_site_uniq ON network_monitors(id,org_id,site_id);
ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_site_scope_fk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_site_scope_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_asset_site_scope_fk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_asset_site_scope_fk FOREIGN KEY(asset_id,org_id,site_id) REFERENCES discovered_assets(id,org_id,site_id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_site_owner_chk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_site_owner_chk CHECK(site_id IS NULL OR org_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS topology_probe_targets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 site_id uuid NOT NULL,
 key varchar(64) NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 label varchar(255) NOT NULL,
 kind varchar(16) NOT NULL,
 definition jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 created_by uuid,
 updated_by uuid,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_probe_targets_site_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_probe_targets_id_org_site_uniq ON topology_probe_targets(id,org_id,site_id);
ALTER TABLE topology_probe_targets DROP CONSTRAINT IF EXISTS topology_probe_targets_kind_chk;
ALTER TABLE topology_probe_targets ADD CONSTRAINT topology_probe_targets_kind_chk CHECK(kind IN ('dns_name','tcp','https'));
ALTER TABLE topology_probe_targets DROP CONSTRAINT IF EXISTS topology_probe_targets_definition_chk;
ALTER TABLE topology_probe_targets ADD CONSTRAINT topology_probe_targets_definition_chk CHECK(jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 262144);
ALTER TABLE topology_probe_targets DROP CONSTRAINT IF EXISTS topology_probe_targets_revision_chk;
ALTER TABLE topology_probe_targets ADD CONSTRAINT topology_probe_targets_revision_chk CHECK(revision >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS topology_probe_targets_key_uniq ON topology_probe_targets(org_id,site_id,key);
ALTER TABLE topology_probe_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_probe_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_probe_targets;
CREATE POLICY tenant_isolation ON topology_probe_targets USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_probe_targets TO breeze_app;

CREATE TABLE IF NOT EXISTS topology_monitoring_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 site_id uuid NOT NULL,
 key varchar(64) NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,
 definition jsonb NOT NULL,
 subject_node_id uuid,
 subject_relationship_id uuid,
 requester_id uuid,
 authority_generation bigint NOT NULL DEFAULT 0,
 authority_digest varchar(64),
 activation_intent boolean NOT NULL DEFAULT false,
 last_scheduled_at timestamptz,
 next_scheduled_at timestamptz,
 blocked_reason varchar(64),
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_monitoring_policies_site_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_monitoring_policies_id_org_site_uniq ON topology_monitoring_policies(id,org_id,site_id);
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_subject_node_id_fk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_subject_node_id_fk FOREIGN KEY(subject_node_id,org_id,site_id) REFERENCES topology_nodes(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_subject_relationship_id_fk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_subject_relationship_id_fk FOREIGN KEY(subject_relationship_id,org_id,site_id) REFERENCES topology_relationships(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_definition_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_definition_chk CHECK(jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 262144);
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_subject_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_subject_chk CHECK(num_nonnulls(subject_node_id, subject_relationship_id) <= 1);
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_revision_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_revision_chk CHECK(revision >= 0 AND authority_generation >= 0);
ALTER TABLE topology_monitoring_policies DROP CONSTRAINT IF EXISTS topology_monitoring_policies_authority_chk;
ALTER TABLE topology_monitoring_policies ADD CONSTRAINT topology_monitoring_policies_authority_chk CHECK(NOT enabled OR authority_digest IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS topology_monitoring_policies_key_uniq ON topology_monitoring_policies(org_id,site_id,key);
ALTER TABLE topology_monitoring_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_monitoring_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_monitoring_policies;
CREATE POLICY tenant_isolation ON topology_monitoring_policies USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_monitoring_policies TO breeze_app;

CREATE TABLE IF NOT EXISTS topology_policy_targets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 site_id uuid NOT NULL,
 policy_id uuid NOT NULL,
 target_id uuid NOT NULL,
 target_revision bigint NOT NULL,
 purpose varchar(32) NOT NULL,
 position integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_policy_targets_site_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_policy_targets_id_org_site_uniq ON topology_policy_targets(id,org_id,site_id);
ALTER TABLE topology_policy_targets DROP CONSTRAINT IF EXISTS topology_policy_targets_policy_id_fk;
ALTER TABLE topology_policy_targets ADD CONSTRAINT topology_policy_targets_policy_id_fk FOREIGN KEY(policy_id,org_id,site_id) REFERENCES topology_monitoring_policies(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_policy_targets DROP CONSTRAINT IF EXISTS topology_policy_targets_target_id_fk;
ALTER TABLE topology_policy_targets ADD CONSTRAINT topology_policy_targets_target_id_fk FOREIGN KEY(target_id,org_id,site_id) REFERENCES topology_probe_targets(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_policy_targets DROP CONSTRAINT IF EXISTS topology_policy_targets_revision_chk;
ALTER TABLE topology_policy_targets ADD CONSTRAINT topology_policy_targets_revision_chk CHECK(target_revision >= 0 AND position >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS topology_policy_targets_target_uniq ON topology_policy_targets(policy_id,target_id,purpose);
ALTER TABLE topology_policy_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_policy_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_policy_targets;
CREATE POLICY tenant_isolation ON topology_policy_targets USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_policy_targets TO breeze_app;

CREATE TABLE IF NOT EXISTS topology_monitor_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 site_id uuid NOT NULL,
 node_id uuid,
 relationship_id uuid,
 monitor_id uuid,
 policy_id uuid,
 context_key varchar(255) NOT NULL,
 family varchar(4) NOT NULL,
 origin_policy jsonb NOT NULL DEFAULT '{}',
 metric_role varchar(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_monitor_bindings_site_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_monitor_bindings_id_org_site_uniq ON topology_monitor_bindings(id,org_id,site_id);
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_node_id_fk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_node_id_fk FOREIGN KEY(node_id,org_id,site_id) REFERENCES topology_nodes(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_relationship_id_fk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_relationship_id_fk FOREIGN KEY(relationship_id,org_id,site_id) REFERENCES topology_relationships(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_monitor_id_fk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_monitor_id_fk FOREIGN KEY(monitor_id,org_id,site_id) REFERENCES network_monitors(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_policy_id_fk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_policy_id_fk FOREIGN KEY(policy_id,org_id,site_id) REFERENCES topology_monitoring_policies(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_subject_chk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_subject_chk CHECK(num_nonnulls(node_id, relationship_id) = 1);
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_owner_chk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_owner_chk CHECK(num_nonnulls(monitor_id, policy_id) >= 1);
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_family_chk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_family_chk CHECK(family IN ('ipv4','ipv6'));
ALTER TABLE topology_monitor_bindings DROP CONSTRAINT IF EXISTS topology_monitor_bindings_origin_chk;
ALTER TABLE topology_monitor_bindings ADD CONSTRAINT topology_monitor_bindings_origin_chk CHECK(jsonb_typeof(origin_policy) = 'object' AND octet_length(origin_policy::text) <= 8192);
ALTER TABLE topology_monitor_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_monitor_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_monitor_bindings;
CREATE POLICY tenant_isolation ON topology_monitor_bindings USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_monitor_bindings TO breeze_app;

CREATE TABLE IF NOT EXISTS topology_diagnostic_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 site_id uuid NOT NULL,
 recipe_id varchar(32) NOT NULL,
 recipe_version integer NOT NULL,
 requester_id uuid NOT NULL,
 subject_node_id uuid,
 subject_relationship_id uuid,
 subject_target_id uuid,
 origin_node_id uuid NOT NULL,
 origin_snapshot jsonb NOT NULL,
 plan jsonb NOT NULL,
 plan_digest varchar(64) NOT NULL,
 idempotency_key varchar(255) NOT NULL,
 body_hash varchar(64) NOT NULL,
 attempt_id uuid NOT NULL,
 command_id uuid,
 state varchar(16) NOT NULL DEFAULT 'queued',
 assessment varchar(16) NOT NULL DEFAULT 'unknown',
 coverage varchar(8) NOT NULL DEFAULT 'none',
 reasons jsonb NOT NULL DEFAULT '[]',
 queued_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 queue_deadline timestamptz NOT NULL,
 deadline timestamptz NOT NULL,
 finished_at timestamptz,
 cancel_requested_at timestamptz,
 failure_reason varchar(64),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_diagnostic_runs_site_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_diagnostic_runs_id_org_site_uniq ON topology_diagnostic_runs(id,org_id,site_id);
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_subject_node_id_fk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_subject_node_id_fk FOREIGN KEY(subject_node_id,org_id,site_id) REFERENCES topology_nodes(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_subject_relationship_id_fk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_subject_relationship_id_fk FOREIGN KEY(subject_relationship_id,org_id,site_id) REFERENCES topology_relationships(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_subject_target_id_fk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_subject_target_id_fk FOREIGN KEY(subject_target_id,org_id,site_id) REFERENCES topology_probe_targets(id,org_id,site_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_origin_node_id_fk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_origin_node_id_fk FOREIGN KEY(origin_node_id,org_id,site_id) REFERENCES topology_nodes(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_subject_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_subject_chk CHECK(num_nonnulls(subject_node_id, subject_relationship_id, subject_target_id) = 1);
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_state_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_state_chk CHECK(state IN ('queued','running','completed','failed','cancelled','expired'));
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_assessment_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_assessment_chk CHECK(assessment IN ('healthy','degraded','failed_check','unknown'));
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_coverage_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_coverage_chk CHECK(coverage IN ('complete','partial','none'));
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_plan_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_plan_chk CHECK(jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 262144);
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_origin_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_origin_chk CHECK(jsonb_typeof(origin_snapshot) = 'object' AND octet_length(origin_snapshot::text) <= 8192);
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_reasons_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_reasons_chk CHECK(jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) <= 64);
ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_deadline_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_deadline_chk CHECK(deadline >= queue_deadline AND queue_deadline > queued_at);
CREATE UNIQUE INDEX IF NOT EXISTS topology_diagnostic_runs_request_uniq ON topology_diagnostic_runs(org_id,site_id,requester_id,idempotency_key);
ALTER TABLE topology_diagnostic_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_diagnostic_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_diagnostic_runs;
CREATE POLICY tenant_isolation ON topology_diagnostic_runs USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_diagnostic_runs TO breeze_app;

CREATE TABLE IF NOT EXISTS topology_diagnostic_steps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 site_id uuid NOT NULL,
 run_id uuid NOT NULL,
 attempt_id uuid NOT NULL,
 step_id uuid NOT NULL,
 command_id uuid NOT NULL,
 state varchar(24) NOT NULL,
 result jsonb NOT NULL,
 historical_only boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_diagnostic_steps_site_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_diagnostic_steps_id_org_site_uniq ON topology_diagnostic_steps(id,org_id,site_id);
ALTER TABLE topology_diagnostic_steps DROP CONSTRAINT IF EXISTS topology_diagnostic_steps_run_id_fk;
ALTER TABLE topology_diagnostic_steps ADD CONSTRAINT topology_diagnostic_steps_run_id_fk FOREIGN KEY(run_id,org_id,site_id) REFERENCES topology_diagnostic_runs(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_diagnostic_steps DROP CONSTRAINT IF EXISTS topology_diagnostic_steps_state_chk;
ALTER TABLE topology_diagnostic_steps ADD CONSTRAINT topology_diagnostic_steps_state_chk CHECK(state IN ('pending','running','succeeded','failed_check','timeout','unsupported','skipped','cancelled','execution_error'));
ALTER TABLE topology_diagnostic_steps DROP CONSTRAINT IF EXISTS topology_diagnostic_steps_result_chk;
ALTER TABLE topology_diagnostic_steps ADD CONSTRAINT topology_diagnostic_steps_result_chk CHECK(jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16384);
CREATE UNIQUE INDEX IF NOT EXISTS topology_diagnostic_steps_result_uniq ON topology_diagnostic_steps(run_id,attempt_id,step_id);
ALTER TABLE topology_diagnostic_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_diagnostic_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_diagnostic_steps;
CREATE POLICY tenant_isolation ON topology_diagnostic_steps USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON topology_diagnostic_steps TO breeze_app;

-- One detachment function is shared by service moves, collision cleanup and the
-- SQL backstop. Retained canonical nodes/runs/results stay in their original site.
CREATE OR REPLACE FUNCTION breeze_detach_topology_monitor_authority(
 p_kind text, p_inventory_id uuid, p_org_id uuid, p_site_id uuid, p_reason text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE monitor_ids uuid[]; node_ids uuid[];
BEGIN
 SELECT coalesce(array_agg(node_id),'{}'::uuid[]) INTO node_ids FROM topology_node_bindings
 WHERE org_id=p_org_id AND site_id=p_site_id AND
 ((p_kind='asset' AND discovered_asset_id=p_inventory_id) OR (p_kind='device' AND device_id=p_inventory_id));
 SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO monitor_ids FROM network_monitors
 WHERE p_kind='asset' AND org_id=p_org_id AND asset_id=p_inventory_id;
 UPDATE topology_monitoring_policies SET enabled=false, authority_digest=NULL,
  authority_generation=authority_generation+1, blocked_reason=p_reason, updated_at=now()
 WHERE org_id=p_org_id AND site_id=p_site_id AND
 (subject_node_id=ANY(node_ids) OR id IN (SELECT policy_id FROM topology_monitor_bindings WHERE org_id=p_org_id AND site_id=p_site_id AND monitor_id=ANY(monitor_ids)));
 UPDATE topology_diagnostic_runs SET cancel_requested_at=coalesce(cancel_requested_at,now()),
  state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,
  failure_reason=p_reason, finished_at=CASE WHEN state='queued' THEN now() ELSE finished_at END, updated_at=now()
 WHERE org_id=p_org_id AND site_id=p_site_id AND state IN ('queued','running') AND
 (origin_node_id=ANY(node_ids) OR subject_node_id=ANY(node_ids) OR (p_kind='device' AND origin_snapshot->>'deviceId'=p_inventory_id::text));
 UPDATE device_commands SET status='cancelled', completed_at=now()
 WHERE status='pending' AND id IN (SELECT command_id FROM topology_diagnostic_runs
 WHERE org_id=p_org_id AND site_id=p_site_id AND state='cancelled' AND failure_reason=p_reason);
 DELETE FROM topology_monitor_bindings WHERE org_id=p_org_id AND site_id=p_site_id AND (monitor_id=ANY(monitor_ids) OR node_id=ANY(node_ids));
 UPDATE network_monitors SET is_active=false, asset_id=NULL, updated_at=now()
 WHERE org_id=p_org_id AND id=ANY(monitor_ids);
END $$;
CREATE OR REPLACE FUNCTION breeze_topology_authority_detach() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.site_id IS DISTINCT FROM OLD.site_id THEN
  PERFORM breeze_detach_topology_monitor_authority(CASE WHEN TG_TABLE_NAME='devices' THEN 'device' ELSE 'asset' END,
   OLD.id,OLD.org_id,OLD.site_id,CASE WHEN TG_OP='DELETE' THEN 'inventory_deleted' ELSE 'inventory_moved' END);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_authority_detach ON devices;
CREATE TRIGGER breeze_topology_authority_detach BEFORE UPDATE OR DELETE ON devices FOR EACH ROW EXECUTE FUNCTION breeze_topology_authority_detach();
DROP TRIGGER IF EXISTS breeze_topology_authority_detach ON discovered_assets;
CREATE TRIGGER breeze_topology_authority_detach BEFORE UPDATE OR DELETE ON discovered_assets FOR EACH ROW EXECUTE FUNCTION breeze_topology_authority_detach();

-- Older monitor writers need the same explicit asset site binding as new ones.
CREATE OR REPLACE FUNCTION breeze_topology_monitor_site() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE asset_site uuid; asset_org uuid;
BEGIN
 IF NEW.asset_id IS NOT NULL THEN
  SELECT site_id,org_id INTO asset_site,asset_org FROM discovered_assets WHERE id=NEW.asset_id;
  IF asset_org IS DISTINCT FROM NEW.org_id OR asset_site IS NULL THEN
   RAISE EXCEPTION 'monitor asset scope mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.site_id IS NULL THEN NEW.site_id=asset_site; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_monitor_site ON network_monitors;
CREATE TRIGGER breeze_topology_monitor_site BEFORE INSERT OR UPDATE OF asset_id,site_id ON network_monitors FOR EACH ROW EXECUTE FUNCTION breeze_topology_monitor_site();

CREATE OR REPLACE FUNCTION breeze_topology_diagnostic_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.plan,NEW.plan_digest,NEW.origin_snapshot,NEW.idempotency_key,NEW.body_hash,NEW.requester_id,NEW.attempt_id,
        NEW.recipe_id,NEW.recipe_version,NEW.subject_node_id,NEW.subject_relationship_id,NEW.subject_target_id,NEW.origin_node_id,NEW.queued_at,NEW.queue_deadline,NEW.deadline)
 IS DISTINCT FROM ROW(OLD.plan,OLD.plan_digest,OLD.origin_snapshot,OLD.idempotency_key,OLD.body_hash,OLD.requester_id,OLD.attempt_id,
        OLD.recipe_id,OLD.recipe_version,OLD.subject_node_id,OLD.subject_relationship_id,OLD.subject_target_id,OLD.origin_node_id,OLD.queued_at,OLD.queue_deadline,OLD.deadline) THEN
  RAISE EXCEPTION 'accepted diagnostic plan is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.state IN ('completed','failed','cancelled','expired') AND NEW.state IS DISTINCT FROM OLD.state THEN
  RAISE EXCEPTION 'terminal diagnostic state is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.command_id IS NOT NULL AND NEW.command_id IS DISTINCT FROM OLD.command_id THEN
  RAISE EXCEPTION 'diagnostic command binding is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_diagnostic_run_guard ON topology_diagnostic_runs;
CREATE TRIGGER breeze_topology_diagnostic_run_guard BEFORE UPDATE ON topology_diagnostic_runs FOR EACH ROW EXECUTE FUNCTION breeze_topology_diagnostic_run_guard();
