-- Collection current state is compact; only admitted changed content gets history.
CREATE TABLE IF NOT EXISTS topology_interfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, site_id uuid NOT NULL,
  owner_node_id uuid NOT NULL, interface_key varchar(255) NOT NULL, epoch varchar(255) NOT NULL,
  kind varchar(32) NOT NULL DEFAULT 'unknown', role varchar(64), name varchar(255), alias varchar(255),
  os_index numeric(10,0), addresses jsonb NOT NULL DEFAULT '[]', controller_port_key varchar(255),
  parent_interface_id uuid, last_observed_at timestamptz, last_outcome varchar(24),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_interfaces_os_index_chk CHECK (os_index BETWEEN 0 AND 4294967295),
  CONSTRAINT topology_interfaces_addresses_chk CHECK (jsonb_typeof(addresses) = 'array' AND jsonb_array_length(addresses) <= 1024 AND octet_length(addresses::text) <= 262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_interfaces_scope_uniq ON topology_interfaces(id,org_id,site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_interfaces_owner_scope_uniq ON topology_interfaces(id,owner_node_id,org_id,site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_interfaces_identity_uniq ON topology_interfaces(owner_node_id,interface_key,epoch);

CREATE TABLE IF NOT EXISTS topology_collection_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, site_id uuid NOT NULL,
  producer_id uuid NOT NULL, producer_kind varchar(24) NOT NULL, producer_epoch varchar(255) NOT NULL,
  epoch_issued_at timestamptz NOT NULL DEFAULT now(), configuration_revision varchar(64) NOT NULL DEFAULT '0', protocol varchar(32) NOT NULL,
  context_key varchar(255) NOT NULL, address_family varchar(8) NOT NULL DEFAULT 'any',
  accepted_sequence numeric(20,0) NOT NULL DEFAULT 0, materialized_sequence numeric(20,0) NOT NULL DEFAULT 0,
  confirmed_sequence numeric(20,0) NOT NULL DEFAULT 0, content_digest varchar(64), published_digest varchar(64),
  digest_version integer NOT NULL DEFAULT 1, base_snapshot_id uuid,
  current_baseline jsonb NOT NULL DEFAULT '{}', published_baseline jsonb NOT NULL DEFAULT '{}', pending_misses jsonb NOT NULL DEFAULT '{}',
  first_baseline_at timestamptz, last_full_validation_at timestamptz, confirmed_through_at timestamptz, fresh_until timestamptz,
  expected_interval_seconds integer NOT NULL DEFAULT 300, last_outcome varchar(24) NOT NULL DEFAULT 'not_attempted',
  admission_tokens double precision NOT NULL DEFAULT 2, admission_refill_at timestamptz NOT NULL DEFAULT now(),
  last_received_at timestamptz, quota_rejected_count integer NOT NULL DEFAULT 0, retry_candidate jsonb, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_sources_accepted_sequence_chk CHECK (accepted_sequence BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT topology_sources_materialized_sequence_chk CHECK (materialized_sequence BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT topology_sources_confirmed_sequence_chk CHECK (confirmed_sequence BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT topology_sources_order_chk CHECK (materialized_sequence <= accepted_sequence AND confirmed_sequence <= accepted_sequence),
  CONSTRAINT topology_sources_admission_chk CHECK (admission_tokens BETWEEN 0 AND 2),
  CONSTRAINT topology_sources_family_chk CHECK (address_family IN ('any','ipv4','ipv6')),
  CONSTRAINT topology_sources_kind_chk CHECK (producer_kind IN ('agent','snmp','unifi','discovery')),
  CONSTRAINT topology_sources_bounds_chk CHECK (expected_interval_seconds BETWEEN 30 AND 86400 AND quota_rejected_count >= 0 AND digest_version = 1),
  CONSTRAINT topology_sources_baseline_chk CHECK (jsonb_typeof(current_baseline) = 'object' AND octet_length(current_baseline::text) <= 1048576 AND jsonb_typeof(published_baseline) = 'object' AND octet_length(published_baseline::text) <= 1048576),
  CONSTRAINT topology_sources_misses_chk CHECK (jsonb_typeof(pending_misses) = 'object' AND octet_length(pending_misses::text) <= 524288),
  CONSTRAINT topology_sources_retry_chk CHECK (retry_candidate IS NULL OR (jsonb_typeof(retry_candidate) = 'object' AND octet_length(retry_candidate::text) <= 1048576))
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_collection_sources_scope_uniq ON topology_collection_sources(id,org_id,site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_collection_sources_identity_uniq ON topology_collection_sources(org_id,site_id,producer_kind,producer_id,protocol,context_key,address_family);
CREATE INDEX IF NOT EXISTS topology_collection_sources_producer_idx ON topology_collection_sources(producer_id,revoked_at);

CREATE TABLE IF NOT EXISTS topology_collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, site_id uuid NOT NULL,
  source_id uuid NOT NULL, producer_id uuid NOT NULL, producer_epoch varchar(255) NOT NULL,
  sequence numeric(20,0) NOT NULL, snapshot_id uuid NOT NULL, content_digest varchar(64) NOT NULL, digest_version integer NOT NULL DEFAULT 1,
  parent_job_id uuid, parent_command_id uuid, observed_at timestamptz NOT NULL, effective_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), outcome varchar(24) NOT NULL, completion_scope jsonb NOT NULL DEFAULT '{}', snapshot jsonb NOT NULL,
  row_count integer NOT NULL DEFAULT 0, omitted_row_count integer NOT NULL DEFAULT 0, normalized_bytes integer NOT NULL,
  expected_interval_seconds integer NOT NULL, materialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_runs_sequence_chk CHECK (sequence BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT topology_runs_bounds_chk CHECK (row_count >= 0 AND omitted_row_count >= 0 AND normalized_bytes BETWEEN 0 AND 1048576 AND expected_interval_seconds BETWEEN 30 AND 86400 AND digest_version = 1),
  CONSTRAINT topology_runs_snapshot_chk CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 1048576 AND jsonb_typeof(completion_scope) = 'object' AND octet_length(completion_scope::text) <= 65536)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_collection_runs_scope_uniq ON topology_collection_runs(id,org_id,site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_collection_runs_sequence_uniq ON topology_collection_runs(source_id,producer_epoch,sequence);
CREATE INDEX IF NOT EXISTS topology_collection_runs_retention_idx ON topology_collection_runs(received_at);
CREATE INDEX IF NOT EXISTS topology_collection_runs_budget_idx ON topology_collection_runs(org_id,producer_id,received_at);

CREATE TABLE IF NOT EXISTS topology_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, site_id uuid NOT NULL,
  run_id uuid NOT NULL, observation_key varchar(255) NOT NULL, subject_node_id uuid, subject_interface_id uuid, relationship_id uuid,
  method varchar(32) NOT NULL, evidence_class varchar(16) NOT NULL, attributes jsonb NOT NULL,
  observed_at timestamptz NOT NULL, effective_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL, withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_observations_interface_owner_chk CHECK (subject_interface_id IS NULL OR subject_node_id IS NOT NULL),
  CONSTRAINT topology_observations_attributes_chk CHECK (jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_observations_scope_uniq ON topology_observations(id,org_id,site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_observations_run_key_uniq ON topology_observations(run_id,observation_key);
CREATE INDEX IF NOT EXISTS topology_observations_relationship_idx ON topology_observations(org_id,site_id,relationship_id,effective_at);

CREATE TABLE IF NOT EXISTS topology_relationship_support (
  org_id uuid NOT NULL, site_id uuid NOT NULL, relationship_id uuid NOT NULL, source_id uuid NOT NULL,
  latest_observation_id uuid, producer_epoch varchar(255) NOT NULL, sequence numeric(20,0) NOT NULL, content_digest varchar(64) NOT NULL,
  first_positive_at timestamptz NOT NULL, last_positive_at timestamptz NOT NULL, effective_at timestamptz NOT NULL, fresh_until timestamptz NOT NULL,
  complete_miss_count integer NOT NULL DEFAULT 0, last_miss_sequence numeric(20,0), last_miss_at timestamptz,
  lifecycle varchar(16) NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relationship_id,source_id),
  CONSTRAINT topology_support_sequence_chk CHECK (sequence BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT topology_support_miss_sequence_chk CHECK (last_miss_sequence BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT topology_support_miss_count_chk CHECK (complete_miss_count BETWEEN 0 AND 2),
  CONSTRAINT topology_support_lifecycle_chk CHECK (lifecycle IN ('active','withdrawn','archived'))
);

-- Interface references become enforceable only now, after the target table exists.
ALTER TABLE topology_relationships ADD COLUMN IF NOT EXISTS source_interface_id uuid;
ALTER TABLE topology_relationships ADD COLUMN IF NOT EXISTS target_interface_id uuid;

DO $$
DECLARE fk record; table_name text; command text; policy_name text; clause text;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('topology_interfaces','topology_interfaces_site_fk','site_id,org_id','sites','id,org_id','CASCADE'),
    ('topology_interfaces','topology_interfaces_owner_fk','owner_node_id,org_id,site_id','topology_nodes','id,org_id,site_id','CASCADE'),
    ('topology_interfaces','topology_interfaces_parent_fk','parent_interface_id,owner_node_id,org_id,site_id','topology_interfaces','id,owner_node_id,org_id,site_id','NO ACTION'),
    ('topology_collection_sources','topology_collection_sources_site_fk','site_id,org_id','sites','id,org_id','CASCADE'),
    ('topology_collection_runs','topology_collection_runs_site_fk','site_id,org_id','sites','id,org_id','CASCADE'),
    ('topology_collection_runs','topology_collection_runs_source_fk','source_id,org_id,site_id','topology_collection_sources','id,org_id,site_id','CASCADE'),
    ('topology_observations','topology_observations_site_fk','site_id,org_id','sites','id,org_id','CASCADE'),
    ('topology_observations','topology_observations_run_fk','run_id,org_id,site_id','topology_collection_runs','id,org_id,site_id','CASCADE'),
    ('topology_observations','topology_observations_node_fk','subject_node_id,org_id,site_id','topology_nodes','id,org_id,site_id','CASCADE'),
    ('topology_observations','topology_observations_interface_fk','subject_interface_id,subject_node_id,org_id,site_id','topology_interfaces','id,owner_node_id,org_id,site_id','NO ACTION'),
    ('topology_observations','topology_observations_relationship_fk','relationship_id,org_id,site_id','topology_relationships','id,org_id,site_id','CASCADE'),
    ('topology_relationship_support','topology_support_site_fk','site_id,org_id','sites','id,org_id','CASCADE'),
    ('topology_relationship_support','topology_support_relationship_fk','relationship_id,org_id,site_id','topology_relationships','id,org_id,site_id','CASCADE'),
    ('topology_relationship_support','topology_support_source_fk','source_id,org_id,site_id','topology_collection_sources','id,org_id,site_id','CASCADE'),
    ('topology_relationship_support','topology_support_observation_fk','latest_observation_id,org_id,site_id','topology_observations','id,org_id,site_id','NO ACTION'),
    ('topology_relationships','topology_relationships_source_interface_fk','source_interface_id,source_node_id,org_id,site_id','topology_interfaces','id,owner_node_id,org_id,site_id','NO ACTION'),
    ('topology_relationships','topology_relationships_target_interface_fk','target_interface_id,target_node_id,org_id,site_id','topology_interfaces','id,owner_node_id,org_id,site_id','NO ACTION')
  ) AS defs(tab, name, cols, target, target_cols, deletion) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || fk.tab)::regclass AND conname = fk.name) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES public.%I (%s) ON DELETE %s DEFERRABLE INITIALLY IMMEDIATE',fk.tab,fk.name,fk.cols,fk.target,fk.target_cols,fk.deletion);
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['topology_interfaces','topology_collection_sources','topology_collection_runs','topology_observations','topology_relationship_support'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      policy_name := 'breeze_org_isolation_' || lower(command);
      clause := CASE command WHEN 'INSERT' THEN 'WITH CHECK (breeze_has_org_access(org_id))'
        WHEN 'UPDATE' THEN 'USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))'
        ELSE 'USING (breeze_has_org_access(org_id))' END;
      IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = table_name AND p.policyname = policy_name) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR %s %s',policy_name,table_name,command,clause);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO breeze_app',table_name);
    END IF;
  END LOOP;
END $$;

-- Historical evidence cannot be rewritten; ownership can be repointed by the
-- normal deferred same-partner merge transaction, without a bypass GUC.
CREATE OR REPLACE FUNCTION breeze_topology_evidence_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  allowed := CASE TG_TABLE_NAME WHEN 'topology_collection_runs'
    THEN ARRAY['org_id','materialized_at','updated_at']
    ELSE ARRAY['org_id','withdrawn_at','updated_at'] END;
  IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'Topology historical evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['topology_collection_runs','topology_observations'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||target)::regclass AND tgname='topology_evidence_immutable') THEN
      EXECUTE format('CREATE TRIGGER topology_evidence_immutable BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION breeze_topology_evidence_immutable()',target);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION breeze_topology_source_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM topology_collection_sources WHERE producer_id=OLD.id AND producer_kind='agent'
      AND org_id=OLD.org_id AND site_id=OLD.site_id AND revoked_at IS NULL) THEN
    PERFORM 1 FROM topology_site_state WHERE org_id=OLD.org_id AND site_id=OLD.site_id FOR UPDATE;
    UPDATE topology_collection_sources SET revoked_at=now(),updated_at=now(),pending_misses='{}'
      WHERE producer_id=OLD.id AND producer_kind='agent' AND org_id=OLD.org_id AND site_id=OLD.site_id AND revoked_at IS NULL;
    UPDATE topology_site_state SET build_fence=build_fence+1,dirty_revision=dirty_revision+1,last_build_status='pending',updated_at=now()
      WHERE org_id=OLD.org_id AND site_id=OLD.site_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='devices'::regclass AND tgname='breeze_topology_source_lifecycle') THEN
    CREATE TRIGGER breeze_topology_source_lifecycle BEFORE UPDATE OR DELETE ON devices
      FOR EACH ROW EXECUTE FUNCTION breeze_topology_source_lifecycle();
  END IF;
END $$;
