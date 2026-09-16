-- M0 graph foundation. Composite ownership FKs are deliberately deferrable for org merge.
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('devices', 'devices_id_org_id_site_id_uniq'),
    ('discovered_assets', 'discovered_assets_id_org_id_site_id_uniq'),
    ('topology_manual_nodes', 'topology_manual_nodes_id_org_id_site_id_uniq')
  ) AS targets(table_name, index_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = target.index_name
        AND t.oid = to_regclass('public.' || target.table_name)
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnatts = 3 AND i.indnkeyatts = 3
        AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        ) = ARRAY['id', 'org_id', 'site_id']::text[]
    ) THEN
      RAISE EXCEPTION 'Topology prerequisite index public.% is missing, invalid or has the wrong definition', target.index_name;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS topology_site_state (
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  dirty_revision bigint NOT NULL DEFAULT 0,
  materialized_input_revision bigint NOT NULL DEFAULT 0,
  graph_revision bigint NOT NULL DEFAULT 0,
  health_revision bigint NOT NULL DEFAULT 0,
  build_fence bigint NOT NULL DEFAULT 0,
  settings_revision bigint NOT NULL DEFAULT 0,
  effective_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings_digest varchar(64),
  disabled_source_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_build_status varchar(32),
  last_build_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_site_state_pkey PRIMARY KEY (org_id, site_id),
  CONSTRAINT topology_site_state_dirty_revision_chk CHECK (dirty_revision >= 0),
  CONSTRAINT topology_site_state_materialized_input_revision_chk CHECK (materialized_input_revision >= 0),
  CONSTRAINT topology_site_state_graph_revision_chk CHECK (graph_revision >= 0),
  CONSTRAINT topology_site_state_health_revision_chk CHECK (health_revision >= 0),
  CONSTRAINT topology_site_state_build_fence_chk CHECK (build_fence >= 0),
  CONSTRAINT topology_site_state_settings_revision_chk CHECK (settings_revision >= 0),
  CONSTRAINT topology_site_state_effective_settings_chk CHECK (jsonb_typeof(effective_settings) = 'object' AND octet_length(effective_settings::text) <= 262144),
  CONSTRAINT topology_site_state_disabled_source_reasons_chk CHECK (jsonb_typeof(disabled_source_reasons) = 'object' AND octet_length(disabled_source_reasons::text) <= 262144)
);
ALTER TABLE topology_site_state DROP CONSTRAINT IF EXISTS topology_site_state_site_scope_fk;
ALTER TABLE topology_site_state ADD CONSTRAINT topology_site_state_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_site_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_site_state FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS topology_nodes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  identity_key varchar(256) NOT NULL,
  identity_material jsonb NOT NULL,
  kind varchar(24) NOT NULL,
  role varchar(64),
  label_override varchar(255),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  lifecycle varchar(16) NOT NULL DEFAULT 'active',
  alias_target_id uuid,
  revision bigint NOT NULL DEFAULT 0,
  legacy_source_type varchar(40),
  legacy_source_id uuid,
  legacy_source_revision bigint,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_nodes_pkey PRIMARY KEY (id),
  CONSTRAINT topology_nodes_kind_chk CHECK (kind IN ('endpoint','network','gateway','internet','manual')),
  CONSTRAINT topology_nodes_lifecycle_chk CHECK (lifecycle IN ('active','withdrawn','archived')),
  CONSTRAINT topology_node_alias_self_chk CHECK (alias_target_id IS NULL OR alias_target_id <> id),
  CONSTRAINT topology_nodes_identity_material_chk CHECK (jsonb_typeof(identity_material) = 'object' AND identity_material ?& ARRAY['version','kind','sourceKey'] AND identity_material - ARRAY['version','kind','sourceKey'] = '{}'::jsonb AND identity_material->'version' = '1'::jsonb AND jsonb_typeof(identity_material->'kind') = 'string' AND identity_material->>'kind' = kind AND jsonb_typeof(identity_material->'sourceKey') = 'string' AND length(identity_material->>'sourceKey') BETWEEN 1 AND 8192 AND octet_length(identity_material::text) <= 16384),
  CONSTRAINT topology_nodes_attributes_chk CHECK (jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 262144),
  CONSTRAINT topology_nodes_revision_chk CHECK (revision >= 0),
  CONSTRAINT topology_nodes_legacy_source_revision_chk CHECK (legacy_source_revision >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_nodes_id_org_site_uniq ON topology_nodes (id, org_id, site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_nodes_identity_uniq ON topology_nodes (org_id, site_id, identity_key);
ALTER TABLE topology_nodes DROP CONSTRAINT IF EXISTS topology_nodes_site_scope_fk;
ALTER TABLE topology_nodes ADD CONSTRAINT topology_nodes_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_nodes DROP CONSTRAINT IF EXISTS topology_node_alias_scope_fk;
ALTER TABLE topology_nodes ADD CONSTRAINT topology_node_alias_scope_fk
  FOREIGN KEY (alias_target_id, org_id, site_id) REFERENCES topology_nodes (id, org_id, site_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_nodes FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS topology_node_bindings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  node_id uuid NOT NULL,
  device_id uuid,
  discovered_asset_id uuid,
  manual_node_id uuid,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_node_bindings_pkey PRIMARY KEY (id),
  CONSTRAINT topology_binding_inventory_xor_chk CHECK (num_nonnulls(device_id, discovered_asset_id, manual_node_id) = 1),
  CONSTRAINT topology_node_bindings_provenance_chk CHECK (jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_binding_device_id_uniq ON topology_node_bindings (device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topology_binding_discovered_asset_id_uniq ON topology_node_bindings (discovered_asset_id) WHERE discovered_asset_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topology_binding_manual_node_id_uniq ON topology_node_bindings (manual_node_id) WHERE manual_node_id IS NOT NULL;
ALTER TABLE topology_node_bindings DROP CONSTRAINT IF EXISTS topology_node_bindings_site_scope_fk;
ALTER TABLE topology_node_bindings ADD CONSTRAINT topology_node_bindings_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_bindings DROP CONSTRAINT IF EXISTS topology_binding_node_scope_fk;
ALTER TABLE topology_node_bindings ADD CONSTRAINT topology_binding_node_scope_fk
  FOREIGN KEY (node_id, org_id, site_id) REFERENCES topology_nodes (id, org_id, site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_bindings DROP CONSTRAINT IF EXISTS topology_binding_device_scope_fk;
ALTER TABLE topology_node_bindings ADD CONSTRAINT topology_binding_device_scope_fk
  FOREIGN KEY (device_id, org_id, site_id) REFERENCES devices (id, org_id, site_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_bindings DROP CONSTRAINT IF EXISTS topology_binding_asset_scope_fk;
ALTER TABLE topology_node_bindings ADD CONSTRAINT topology_binding_asset_scope_fk
  FOREIGN KEY (discovered_asset_id, org_id, site_id) REFERENCES discovered_assets (id, org_id, site_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_bindings DROP CONSTRAINT IF EXISTS topology_binding_manual_scope_fk;
ALTER TABLE topology_node_bindings ADD CONSTRAINT topology_binding_manual_scope_fk
  FOREIGN KEY (manual_node_id, org_id, site_id) REFERENCES topology_manual_nodes (id, org_id, site_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_node_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS topology_relationships (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  canonical_key varchar(256) NOT NULL,
  identity_material jsonb NOT NULL,
  kind varchar(24) NOT NULL,
  source_node_id uuid NOT NULL,
  target_node_id uuid NOT NULL,
  logical_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  directness varchar(24) NOT NULL DEFAULT 'unknown',
  confidence varchar(16) NOT NULL DEFAULT 'asserted',
  evidence_class varchar(16) NOT NULL DEFAULT 'manual',
  lifecycle varchar(16) NOT NULL DEFAULT 'active',
  first_supported_at timestamptz,
  last_supported_at timestamptz,
  support_count bigint NOT NULL DEFAULT 0,
  graph_revision bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_source_type varchar(40),
  legacy_source_id uuid,
  legacy_source_revision bigint,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_relationships_pkey PRIMARY KEY (id),
  CONSTRAINT topology_relationships_kind_chk CHECK (kind IN ('network_member','default_route','egress_path','physical_link','attachment')),
  CONSTRAINT topology_relationships_directness_chk CHECK (directness IN ('direct','via_unmanaged','unknown')),
  CONSTRAINT topology_relationships_confidence_chk CHECK (confidence IN ('high','medium','low','asserted')),
  CONSTRAINT topology_relationships_evidence_class_chk CHECK (evidence_class IN ('observed','inferred','manual')),
  CONSTRAINT topology_relationships_lifecycle_chk CHECK (lifecycle IN ('active','withdrawn','archived')),
  CONSTRAINT topology_relationships_identity_material_chk CHECK (jsonb_typeof(identity_material) = 'object' AND identity_material ?& ARRAY['version','kind','sourceKey'] AND identity_material - ARRAY['version','kind','sourceKey'] = '{}'::jsonb AND identity_material->'version' = '1'::jsonb AND jsonb_typeof(identity_material->'kind') = 'string' AND identity_material->>'kind' = kind AND jsonb_typeof(identity_material->'sourceKey') = 'string' AND length(identity_material->>'sourceKey') BETWEEN 1 AND 8192 AND octet_length(identity_material::text) <= 16384),
  CONSTRAINT topology_relationships_logical_context_chk CHECK (jsonb_typeof(logical_context) = 'object' AND octet_length(logical_context::text) <= 262144),
  CONSTRAINT topology_relationships_support_count_chk CHECK (support_count >= 0),
  CONSTRAINT topology_relationships_graph_revision_chk CHECK (graph_revision >= 0),
  CONSTRAINT topology_relationships_revision_chk CHECK (revision >= 0),
  CONSTRAINT topology_relationships_attributes_chk CHECK (jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 262144),
  CONSTRAINT topology_relationships_legacy_source_revision_chk CHECK (legacy_source_revision >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_relationships_id_org_site_uniq ON topology_relationships (id, org_id, site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_relationships_canonical_uniq ON topology_relationships (org_id, site_id, canonical_key);
ALTER TABLE topology_relationships DROP CONSTRAINT IF EXISTS topology_relationships_site_scope_fk;
ALTER TABLE topology_relationships ADD CONSTRAINT topology_relationships_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_relationships DROP CONSTRAINT IF EXISTS topology_relationship_source_scope_fk;
ALTER TABLE topology_relationships ADD CONSTRAINT topology_relationship_source_scope_fk
  FOREIGN KEY (source_node_id, org_id, site_id) REFERENCES topology_nodes (id, org_id, site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_relationships DROP CONSTRAINT IF EXISTS topology_relationship_target_scope_fk;
ALTER TABLE topology_relationships ADD CONSTRAINT topology_relationship_target_scope_fk
  FOREIGN KEY (target_node_id, org_id, site_id) REFERENCES topology_nodes (id, org_id, site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_relationships FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS topology_layouts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  view varchar(16) NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  algorithm varchar(64),
  algorithm_version varchar(32),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_layouts_pkey PRIMARY KEY (id),
  CONSTRAINT topology_layouts_view_chk CHECK (view IN ('overview','physical','logical')),
  CONSTRAINT topology_layouts_revision_chk CHECK (revision >= 0),
  CONSTRAINT topology_layouts_settings_chk CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_layouts_id_org_site_uniq ON topology_layouts (id, org_id, site_id);
CREATE UNIQUE INDEX IF NOT EXISTS topology_layouts_view_uniq ON topology_layouts (org_id, site_id, view);
ALTER TABLE topology_layouts DROP CONSTRAINT IF EXISTS topology_layouts_site_scope_fk;
ALTER TABLE topology_layouts ADD CONSTRAINT topology_layouts_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_layouts FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS topology_node_positions (
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  layout_id uuid NOT NULL,
  node_id uuid NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  position_source varchar(16) NOT NULL DEFAULT 'auto',
  revision bigint NOT NULL DEFAULT 0,
  updated_by uuid,
  legacy_source_revision bigint,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_node_positions_pkey PRIMARY KEY (layout_id, node_id),
  CONSTRAINT topology_position_coordinates_chk CHECK (x BETWEEN -1000000 AND 1000000 AND y BETWEEN -1000000 AND 1000000),
  CONSTRAINT topology_node_positions_position_source_chk CHECK (position_source IN ('auto','user','legacy')),
  CONSTRAINT topology_node_positions_revision_chk CHECK (revision >= 0),
  CONSTRAINT topology_node_positions_legacy_source_revision_chk CHECK (legacy_source_revision >= 0)
);
ALTER TABLE topology_node_positions DROP CONSTRAINT IF EXISTS topology_node_positions_site_scope_fk;
ALTER TABLE topology_node_positions ADD CONSTRAINT topology_node_positions_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_positions DROP CONSTRAINT IF EXISTS topology_position_node_scope_fk;
ALTER TABLE topology_node_positions ADD CONSTRAINT topology_position_node_scope_fk
  FOREIGN KEY (node_id, org_id, site_id) REFERENCES topology_nodes (id, org_id, site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_positions DROP CONSTRAINT IF EXISTS topology_position_layout_scope_fk;
ALTER TABLE topology_node_positions ADD CONSTRAINT topology_position_layout_scope_fk
  FOREIGN KEY (layout_id, org_id, site_id) REFERENCES topology_layouts (id, org_id, site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_node_positions FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS topology_change_outbox (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  event_kind varchar(64) NOT NULL,
  aggregate_id uuid NOT NULL,
  source_revision bigint NOT NULL DEFAULT 0,
  idempotency_key varchar(256) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error varchar(1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_change_outbox_pkey PRIMARY KEY (id),
  CONSTRAINT topology_outbox_attempt_count_chk CHECK (attempt_count >= 0),
  CONSTRAINT topology_change_outbox_source_revision_chk CHECK (source_revision >= 0),
  CONSTRAINT topology_change_outbox_payload_chk CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_outbox_idempotency_uniq ON topology_change_outbox (org_id, site_id, idempotency_key);
CREATE INDEX IF NOT EXISTS topology_outbox_revision_idx ON topology_change_outbox (org_id, site_id, source_revision);
CREATE INDEX IF NOT EXISTS topology_outbox_pending_idx ON topology_change_outbox (next_attempt_at, created_at) WHERE delivered_at IS NULL;
ALTER TABLE topology_change_outbox DROP CONSTRAINT IF EXISTS topology_change_outbox_site_scope_fk;
ALTER TABLE topology_change_outbox ADD CONSTRAINT topology_change_outbox_site_scope_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_change_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_change_outbox FORCE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text; command text; policy_name text; clause text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['topology_site_state','topology_nodes','topology_node_bindings','topology_relationships','topology_layouts','topology_node_positions','topology_change_outbox'] LOOP
    FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      policy_name := 'breeze_org_isolation_' || lower(command);
      clause := CASE command
        WHEN 'INSERT' THEN 'WITH CHECK (breeze_has_org_access(org_id))'
        WHEN 'UPDATE' THEN 'USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))'
        ELSE 'USING (breeze_has_org_access(org_id))' END;
      IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
        AND p.tablename = table_name AND p.policyname = policy_name) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR %s %s', policy_name, table_name, command, clause);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO breeze_app', table_name);
    END IF;
  END LOOP;
END $$;
