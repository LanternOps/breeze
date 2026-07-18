-- Desired-configuration exports contain nested children (policy features,
-- assignments, device custom values). A coarse per-org/resource material
-- clock makes those mutations visible to incremental pagination while storing
-- no source definitions or secret-bearing values.

CREATE TABLE IF NOT EXISTS public.partner_export_configuration_org_state (
  resource varchar(40) NOT NULL CHECK (resource IN (
    'configuration-policies', 'configuration-assignments', 'scripts',
    'automations', 'backup-configurations', 'custom-fields'
  )),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  updated_at timestamp(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (resource, org_id)
);

CREATE INDEX IF NOT EXISTS partner_export_configuration_org_state_org_id_idx
  ON partner_export_configuration_org_state(org_id);

INSERT INTO public.partner_export_configuration_org_state(resource, org_id, updated_at)
SELECT resource, o.id, public.breeze_partner_export_next_timestamp(o.partner_export_updated_at)
FROM public.organizations o
CROSS JOIN unnest(ARRAY[
  'configuration-policies', 'configuration-assignments', 'scripts',
  'automations', 'backup-configurations', 'custom-fields'
]::text[]) resource
ON CONFLICT (resource, org_id) DO NOTHING;

ALTER TABLE partner_export_configuration_org_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_export_configuration_org_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.partner_export_configuration_org_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.partner_export_configuration_org_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.partner_export_configuration_org_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.partner_export_configuration_org_state;
CREATE POLICY breeze_org_isolation_select ON partner_export_configuration_org_state
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON partner_export_configuration_org_state
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON partner_export_configuration_org_state
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON partner_export_configuration_org_state
  FOR DELETE USING (public.breeze_has_org_access(org_id));

CREATE OR REPLACE FUNCTION public.breeze_partner_export_touch_configuration_orgs(
  org_ids uuid[], resources text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  partner_ids uuid[];
  held_orgs uuid[];
  unresolved_count bigint;
BEGIN
  IF COALESCE(array_length(org_ids, 1), 0) = 0 OR COALESCE(array_length(resources, 1), 0) = 0 THEN
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT o.partner_id ORDER BY o.partner_id), count(DISTINCT o.id)
    INTO partner_ids, unresolved_count
    FROM public.organizations o
   WHERE o.id = ANY(org_ids);
  IF unresolved_count <> cardinality(org_ids) THEN
    RAISE EXCEPTION 'partner export configuration touch requested an unknown organization'
      USING ERRCODE = 'P0001';
  END IF;
  held_orgs := COALESCE(
    string_to_array(NULLIF(current_setting('breeze.partner_export_org_locks', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
  -- Device custom-field updates already hold the canonical org lock through
  -- the devices transition trigger. Other configuration mutations take the
  -- partner-exclusive lock first so later same-transaction org cleanup never
  -- attempts a shared-to-exclusive upgrade.
  IF NOT org_ids <@ held_orgs THEN
    PERFORM public.breeze_partner_export_lock_partners_exclusive(partner_ids);
    PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(org_ids, partner_ids);
  END IF;
  INSERT INTO public.partner_export_configuration_org_state(resource, org_id, updated_at)
  SELECT resource, org_id, public.breeze_partner_export_next_timestamp(NULL::timestamp)
  FROM unnest(resources) resource CROSS JOIN unnest(org_ids) org_id
  ON CONFLICT (resource, org_id) DO UPDATE SET
    updated_at = public.breeze_partner_export_next_timestamp(
      public.partner_export_configuration_org_state.updated_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_configuration_owner_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[]; resources text[];
BEGIN
  SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
  FROM new_rows row
  JOIN public.organizations o
    ON o.id = (to_jsonb(row)->>'org_id')::uuid
    OR ((to_jsonb(row)->>'org_id') IS NULL AND o.partner_id = (to_jsonb(row)->>'partner_id')::uuid);
  resources := CASE TG_TABLE_NAME
    WHEN 'configuration_policies' THEN ARRAY['configuration-policies', 'configuration-assignments']
    WHEN 'scripts' THEN ARRAY['scripts']
    WHEN 'automations' THEN ARRAY['automations']
    WHEN 'backup_profiles' THEN ARRAY['backup-configurations']
    WHEN 'custom_field_definitions' THEN ARRAY['custom-fields']
    ELSE ARRAY[]::text[] END;
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, resources);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_configuration_owner_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[]; resources text[];
BEGIN
  SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
  FROM old_rows row
  JOIN public.organizations o
    ON o.id = (to_jsonb(row)->>'org_id')::uuid
    OR ((to_jsonb(row)->>'org_id') IS NULL AND o.partner_id = (to_jsonb(row)->>'partner_id')::uuid);
  resources := CASE TG_TABLE_NAME
    WHEN 'configuration_policies' THEN ARRAY['configuration-policies', 'configuration-assignments']
    WHEN 'scripts' THEN ARRAY['scripts']
    WHEN 'automations' THEN ARRAY['automations']
    WHEN 'backup_profiles' THEN ARRAY['backup-configurations']
    WHEN 'custom_field_definitions' THEN ARRAY['custom-fields']
    ELSE ARRAY[]::text[] END;
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, resources);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_configuration_owner_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[]; resources text[];
BEGIN
  IF TG_TABLE_NAME = 'automations' THEN
    WITH changed AS (
      SELECT to_jsonb(o) old_value, to_jsonb(n) new_value
      FROM old_rows o JOIN new_rows n USING (id)
      WHERE (to_jsonb(o) - ARRAY['last_run_at', 'run_count', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(n) - ARRAY['last_run_at', 'run_count', 'updated_at'])
    ), affected AS (
      SELECT old_value value FROM changed UNION ALL SELECT new_value FROM changed
    )
    SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
    FROM affected row
    JOIN public.organizations o
      ON o.id = (row.value->>'org_id')::uuid
      OR ((row.value->>'org_id') IS NULL AND o.partner_id = (row.value->>'partner_id')::uuid);
  ELSE
    WITH affected AS (
      SELECT to_jsonb(row) value FROM old_rows row
      UNION ALL SELECT to_jsonb(row) value FROM new_rows row
    )
    SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
    FROM affected row
    JOIN public.organizations o
      ON o.id = (row.value->>'org_id')::uuid
      OR ((row.value->>'org_id') IS NULL AND o.partner_id = (row.value->>'partner_id')::uuid);
  END IF;
  resources := CASE TG_TABLE_NAME
    WHEN 'configuration_policies' THEN ARRAY['configuration-policies', 'configuration-assignments']
    WHEN 'scripts' THEN ARRAY['scripts']
    WHEN 'automations' THEN ARRAY['automations']
    WHEN 'backup_profiles' THEN ARRAY['backup-configurations']
    WHEN 'custom_field_definitions' THEN ARRAY['custom-fields']
    ELSE ARRAY[]::text[] END;
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, resources);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_policy_child_orgs(row_values jsonb[])
RETURNS uuid[] LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH policy_ids AS (
    SELECT DISTINCT COALESCE(value->>'config_policy_id', fl.config_policy_id::text)::uuid AS id
    FROM unnest(row_values) value
    LEFT JOIN public.config_policy_feature_links fl ON fl.id = NULLIF(value->>'feature_link_id', '')::uuid
  ), policy_owners AS (
    SELECT cp.* FROM public.configuration_policies cp JOIN policy_ids p ON p.id = cp.id
  )
  SELECT array_agg(DISTINCT o.id ORDER BY o.id)
  FROM policy_owners cp
  JOIN public.organizations o ON o.id = cp.org_id OR (cp.org_id IS NULL AND o.partner_id = cp.partner_id);
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_policy_child_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE values jsonb[]; org_ids uuid[];
BEGIN
  SELECT array_agg(to_jsonb(row)) INTO values FROM new_rows row;
  org_ids := public.breeze_partner_export_policy_child_orgs(values);
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['configuration-policies']);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_policy_child_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE values jsonb[]; org_ids uuid[];
BEGIN
  SELECT array_agg(to_jsonb(row)) INTO values FROM old_rows row;
  org_ids := public.breeze_partner_export_policy_child_orgs(values);
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['configuration-policies']);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_policy_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE values jsonb[]; org_ids uuid[];
BEGIN
  SELECT array_agg(value) INTO values FROM (
    SELECT to_jsonb(row) value FROM old_rows row
    UNION ALL SELECT to_jsonb(row) value FROM new_rows row
  ) affected;
  org_ids := public.breeze_partner_export_policy_child_orgs(values);
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['configuration-policies']);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_assignment_orgs(row_values jsonb[])
RETURNS uuid[] LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH assignments AS (
    SELECT value, cp.org_id policy_org_id, cp.partner_id policy_partner_id
    FROM unnest(row_values) value
    JOIN public.configuration_policies cp ON cp.id = (value->>'config_policy_id')::uuid
  )
  SELECT array_agg(DISTINCT o.id ORDER BY o.id)
  FROM assignments a
  JOIN public.organizations o ON o.id = a.policy_org_id OR (a.policy_org_id IS NULL AND o.partner_id = a.policy_partner_id)
  WHERE
    (a.value->>'level' = 'partner' AND (a.value->>'target_id')::uuid = a.policy_partner_id)
    OR (a.value->>'level' = 'organization' AND (a.value->>'target_id')::uuid = o.id)
    OR (a.value->>'level' = 'site' AND EXISTS (
      SELECT 1 FROM public.sites st WHERE st.id = (a.value->>'target_id')::uuid AND st.org_id = o.id))
    OR (a.value->>'level' = 'device_group' AND EXISTS (
      SELECT 1 FROM public.device_groups dg WHERE dg.id = (a.value->>'target_id')::uuid AND dg.org_id = o.id))
    OR (a.value->>'level' = 'device' AND EXISTS (
      SELECT 1 FROM public.devices d WHERE d.id = (a.value->>'target_id')::uuid AND d.org_id = o.id));
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_assignment_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE values jsonb[]; org_ids uuid[];
BEGIN
  SELECT array_agg(to_jsonb(row)) INTO values FROM new_rows row;
  org_ids := public.breeze_partner_export_assignment_orgs(values);
  PERFORM public.breeze_partner_export_touch_configuration_orgs(
    org_ids, ARRAY['configuration-policies', 'configuration-assignments']
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_assignment_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE values jsonb[]; org_ids uuid[];
BEGIN
  SELECT array_agg(to_jsonb(row)) INTO values FROM old_rows row;
  org_ids := public.breeze_partner_export_assignment_orgs(values);
  PERFORM public.breeze_partner_export_touch_configuration_orgs(
    org_ids, ARRAY['configuration-policies', 'configuration-assignments']
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_assignment_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE values jsonb[]; org_ids uuid[];
BEGIN
  SELECT array_agg(value) INTO values FROM (
    SELECT to_jsonb(row) value FROM old_rows row
    UNION ALL SELECT to_jsonb(row) value FROM new_rows row
  ) affected;
  org_ids := public.breeze_partner_export_assignment_orgs(values);
  PERFORM public.breeze_partner_export_touch_configuration_orgs(
    org_ids, ARRAY['configuration-policies', 'configuration-assignments']
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_direct_org_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'org_id')::uuid ORDER BY (to_jsonb(row)->>'org_id')::uuid)
    INTO org_ids FROM new_rows row;
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['backup-configurations']);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_direct_org_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'org_id')::uuid ORDER BY (to_jsonb(row)->>'org_id')::uuid)
    INTO org_ids FROM old_rows row;
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['backup-configurations']);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_direct_org_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'backup_configs' THEN
    WITH changed AS (
      SELECT to_jsonb(o) old_value, to_jsonb(n) new_value
      FROM old_rows o JOIN new_rows n USING (id)
      WHERE (to_jsonb(o) - ARRAY[
          'provider_config', 'encryption_key', 'provider_capabilities',
          'provider_capabilities_checked_at', 'updated_at'
        ]) IS DISTINCT FROM (to_jsonb(n) - ARRAY[
          'provider_config', 'encryption_key', 'provider_capabilities',
          'provider_capabilities_checked_at', 'updated_at'
        ])
    ), affected AS (
      SELECT (old_value->>'org_id')::uuid org_id FROM changed
      UNION SELECT (new_value->>'org_id')::uuid FROM changed
    )
    SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM affected;
  ELSE
    SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM (
      SELECT (to_jsonb(row)->>'org_id')::uuid org_id FROM old_rows row
      UNION SELECT (to_jsonb(row)->>'org_id')::uuid FROM new_rows row
    ) affected;
  END IF;
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['backup-configurations']);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_custom_values_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT COALESCE(n.org_id, o.org_id) ORDER BY COALESCE(n.org_id, o.org_id)) INTO org_ids
  FROM old_rows o JOIN new_rows n USING (id)
  WHERE o.custom_fields IS DISTINCT FROM n.custom_fields OR o.org_id IS DISTINCT FROM n.org_id;
  PERFORM public.breeze_partner_export_touch_configuration_orgs(org_ids, ARRAY['custom-fields']);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_initialize_configuration_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.partner_export_configuration_org_state(resource, org_id, updated_at)
  SELECT resource, NEW.id, public.breeze_partner_export_next_timestamp(NEW.partner_export_updated_at)
  FROM unnest(ARRAY[
    'configuration-policies', 'configuration-assignments', 'scripts',
    'automations', 'backup-configurations', 'custom-fields'
  ]::text[]) resource
  ON CONFLICT (resource, org_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'configuration_policies', 'scripts', 'automations', 'backup_profiles', 'custom_field_definitions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_configuration_insert ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_configuration_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_configuration_owner_insert()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_configuration_update ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_configuration_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_configuration_owner_update()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_configuration_delete ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_configuration_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_configuration_owner_delete()', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['backup_configs', 'backup_policies'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_configuration_insert ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_configuration_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_direct_org_insert()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_configuration_update ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_configuration_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_direct_org_update()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_configuration_delete ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_configuration_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_direct_org_delete()', table_name);
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_configuration_insert ON public.config_policy_feature_links;
CREATE TRIGGER breeze_partner_export_configuration_insert AFTER INSERT ON config_policy_feature_links
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_policy_child_insert();
DROP TRIGGER IF EXISTS breeze_partner_export_configuration_update ON public.config_policy_feature_links;
CREATE TRIGGER breeze_partner_export_configuration_update AFTER UPDATE ON config_policy_feature_links
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_policy_child_update();
DROP TRIGGER IF EXISTS breeze_partner_export_configuration_delete ON public.config_policy_feature_links;
CREATE TRIGGER breeze_partner_export_configuration_delete AFTER DELETE ON config_policy_feature_links
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_policy_child_delete();

DROP TRIGGER IF EXISTS breeze_partner_export_configuration_insert ON public.config_policy_assignments;
CREATE TRIGGER breeze_partner_export_configuration_insert AFTER INSERT ON config_policy_assignments
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_assignment_insert();
DROP TRIGGER IF EXISTS breeze_partner_export_configuration_update ON public.config_policy_assignments;
CREATE TRIGGER breeze_partner_export_configuration_update AFTER UPDATE ON config_policy_assignments
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_assignment_update();
DROP TRIGGER IF EXISTS breeze_partner_export_configuration_delete ON public.config_policy_assignments;
CREATE TRIGGER breeze_partner_export_configuration_delete AFTER DELETE ON config_policy_assignments
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_assignment_delete();

DROP TRIGGER IF EXISTS breeze_partner_export_custom_values_update ON public.devices;
CREATE TRIGGER breeze_partner_export_custom_values_update AFTER UPDATE ON devices
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_custom_values_update();

DROP TRIGGER IF EXISTS breeze_partner_export_configuration_state_insert ON public.organizations;
CREATE TRIGGER breeze_partner_export_configuration_state_insert AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION public.breeze_partner_export_initialize_configuration_state();

REVOKE ALL ON FUNCTION public.breeze_partner_export_touch_configuration_orgs(uuid[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_configuration_owner_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_configuration_owner_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_configuration_owner_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_policy_child_orgs(jsonb[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_policy_child_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_policy_child_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_policy_child_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_assignment_orgs(jsonb[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_assignment_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_assignment_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_assignment_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_direct_org_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_direct_org_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_direct_org_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_custom_values_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_initialize_configuration_state() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT ON public.partner_export_configuration_org_state TO breeze_app;
    REVOKE INSERT, UPDATE, DELETE ON public.partner_export_configuration_org_state FROM breeze_app;
  END IF;
END $$;
