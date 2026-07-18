-- Resource-specific reconstruction watermarks. Child inventory is often
-- replaced in bulk; statement transition triggers touch each affected owner
-- once and never derive persisted state from raw/provider fields.

CREATE TABLE IF NOT EXISTS public.partner_export_device_material_state (
  device_id uuid PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  inventory_updated_at timestamp(3) NOT NULL DEFAULT now(),
  software_updated_at timestamp(3) NOT NULL DEFAULT now(),
  relationships_updated_at timestamp(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_export_device_material_state_org_device_uniq
  ON public.partner_export_device_material_state(org_id, device_id);
CREATE INDEX IF NOT EXISTS partner_export_device_material_state_org_id_idx
  ON public.partner_export_device_material_state(org_id);

CREATE TABLE IF NOT EXISTS public.partner_export_site_material_state (
  site_id uuid PRIMARY KEY REFERENCES public.sites(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  inventory_updated_at timestamp(3) NOT NULL DEFAULT now(),
  relationships_updated_at timestamp(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_export_site_material_state_org_site_uniq
  ON public.partner_export_site_material_state(org_id, site_id);
CREATE INDEX IF NOT EXISTS partner_export_site_material_state_org_id_idx
  ON public.partner_export_site_material_state(org_id);

INSERT INTO public.partner_export_device_material_state (
  device_id, org_id, inventory_updated_at, software_updated_at, relationships_updated_at
)
SELECT id, org_id, partner_export_updated_at, partner_export_updated_at, partner_export_updated_at
FROM public.devices
ON CONFLICT (device_id) DO NOTHING;

INSERT INTO public.partner_export_site_material_state (
  site_id, org_id, inventory_updated_at, relationships_updated_at
)
SELECT id, org_id, partner_export_updated_at, partner_export_updated_at
FROM public.sites
ON CONFLICT (site_id) DO NOTHING;

ALTER TABLE public.partner_export_device_material_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_export_device_material_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.partner_export_site_material_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_export_site_material_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.partner_export_device_material_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.partner_export_device_material_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.partner_export_device_material_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.partner_export_device_material_state;
CREATE POLICY breeze_org_isolation_select ON public.partner_export_device_material_state
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.partner_export_device_material_state
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.partner_export_device_material_state
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.partner_export_device_material_state
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.partner_export_site_material_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.partner_export_site_material_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.partner_export_site_material_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.partner_export_site_material_state;
CREATE POLICY breeze_org_isolation_select ON public.partner_export_site_material_state
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.partner_export_site_material_state
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.partner_export_site_material_state
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.partner_export_site_material_state
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- Namespace-separated stable batch UUID. MD5 is an identity hash, not a
-- security primitive; the version and variant nibbles are forced explicitly.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_stable_uuid(namespace text, source_id uuid)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT (
    substr(value, 1, 12) || '5' || substr(value, 14, 3)
    || 'a' || substr(value, 18, 15)
  )::uuid
  FROM (SELECT md5(namespace || ':' || source_id::text) AS value) digest;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_touch_devices(
  device_ids uuid[], touch_inventory boolean, touch_software boolean, touch_relationships boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT d.org_id ORDER BY d.org_id) INTO org_ids
  FROM public.devices d WHERE d.id = ANY(COALESCE(device_ids, ARRAY[]::uuid[]));
  IF COALESCE(array_length(org_ids, 1), 0) = 0 THEN RETURN; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  INSERT INTO public.partner_export_device_material_state (
    device_id, org_id, inventory_updated_at, software_updated_at, relationships_updated_at
  )
  SELECT d.id, d.org_id,
         CASE WHEN touch_inventory THEN public.breeze_partner_export_next_timestamp(d.partner_export_updated_at) ELSE d.partner_export_updated_at END,
         CASE WHEN touch_software THEN public.breeze_partner_export_next_timestamp(d.partner_export_updated_at) ELSE d.partner_export_updated_at END,
         CASE WHEN touch_relationships THEN public.breeze_partner_export_next_timestamp(d.partner_export_updated_at) ELSE d.partner_export_updated_at END
  FROM public.devices d WHERE d.id = ANY(COALESCE(device_ids, ARRAY[]::uuid[]))
  ON CONFLICT (device_id) DO UPDATE SET
    org_id = EXCLUDED.org_id,
    inventory_updated_at = CASE WHEN touch_inventory
      THEN public.breeze_partner_export_next_timestamp(partner_export_device_material_state.inventory_updated_at)
      ELSE partner_export_device_material_state.inventory_updated_at END,
    software_updated_at = CASE WHEN touch_software
      THEN public.breeze_partner_export_next_timestamp(partner_export_device_material_state.software_updated_at)
      ELSE partner_export_device_material_state.software_updated_at END,
    relationships_updated_at = CASE WHEN touch_relationships
      THEN public.breeze_partner_export_next_timestamp(partner_export_device_material_state.relationships_updated_at)
      ELSE partner_export_device_material_state.relationships_updated_at END;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_touch_sites(
  site_ids uuid[], touch_inventory boolean, touch_relationships boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT s.org_id ORDER BY s.org_id) INTO org_ids
  FROM public.sites s WHERE s.id = ANY(COALESCE(site_ids, ARRAY[]::uuid[]));
  IF COALESCE(array_length(org_ids, 1), 0) = 0 THEN RETURN; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  INSERT INTO public.partner_export_site_material_state (
    site_id, org_id, inventory_updated_at, relationships_updated_at
  )
  SELECT s.id, s.org_id,
         CASE WHEN touch_inventory THEN public.breeze_partner_export_next_timestamp(s.partner_export_updated_at) ELSE s.partner_export_updated_at END,
         CASE WHEN touch_relationships THEN public.breeze_partner_export_next_timestamp(s.partner_export_updated_at) ELSE s.partner_export_updated_at END
  FROM public.sites s WHERE s.id = ANY(COALESCE(site_ids, ARRAY[]::uuid[]))
  ON CONFLICT (site_id) DO UPDATE SET
    org_id = EXCLUDED.org_id,
    inventory_updated_at = CASE WHEN touch_inventory
      THEN public.breeze_partner_export_next_timestamp(partner_export_site_material_state.inventory_updated_at)
      ELSE partner_export_site_material_state.inventory_updated_at END,
    relationships_updated_at = CASE WHEN touch_relationships
      THEN public.breeze_partner_export_next_timestamp(partner_export_site_material_state.relationships_updated_at)
      ELSE partner_export_site_material_state.relationships_updated_at END;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'device_id')::uuid ORDER BY (to_jsonb(row)->>'device_id')::uuid)
    INTO ids FROM new_rows row;
  PERFORM public.breeze_partner_export_touch_devices(
    ids,
    TG_TABLE_NAME <> 'software_inventory',
    TG_TABLE_NAME = 'software_inventory',
    TG_TABLE_NAME IN ('device_network', 'device_ip_history', 'hyperv_vms')
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'device_id')::uuid ORDER BY (to_jsonb(row)->>'device_id')::uuid)
    INTO ids FROM old_rows row;
  PERFORM public.breeze_partner_export_touch_devices(
    ids,
    TG_TABLE_NAME <> 'software_inventory',
    TG_TABLE_NAME = 'software_inventory',
    TG_TABLE_NAME IN ('device_network', 'device_ip_history', 'hyperv_vms')
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; excluded text[];
BEGIN
  excluded := CASE TG_TABLE_NAME
    WHEN 'device_hardware' THEN ARRAY['updated_at', 'partner_export_updated_at']
    WHEN 'device_disks' THEN ARRAY['used_gb', 'free_gb', 'used_percent', 'health', 'updated_at']
    WHEN 'device_network' THEN ARRAY['ip_address', 'ip_type', 'public_ip', 'updated_at']
    WHEN 'device_ip_history' THEN ARRAY['last_seen', 'updated_at']
    WHEN 'software_inventory' THEN ARRAY['catalog_id', 'install_location', 'uninstall_string', 'last_seen', 'file_hash', 'hash_algorithm']
    WHEN 'device_warranty' THEN ARRAY['manufacturer', 'serial_number', 'entitlements', 'data_source', 'last_sync_at', 'last_sync_error', 'next_sync_at', 'updated_at']
    WHEN 'hyperv_vms' THEN ARRAY['state', 'vhd_paths', 'checkpoints', 'notes', 'last_discovered_at', 'updated_at']
    ELSE ARRAY[]::text[]
  END;
  WITH old_data AS (
    SELECT COALESCE(to_jsonb(row)->>'id', to_jsonb(row)->>'device_id') AS row_key, to_jsonb(row) AS value FROM old_rows row
  ), new_data AS (
    SELECT COALESCE(to_jsonb(row)->>'id', to_jsonb(row)->>'device_id') AS row_key, to_jsonb(row) AS value FROM new_rows row
  )
  SELECT array_agg(DISTINCT COALESCE(n.value->>'device_id', o.value->>'device_id')::uuid
                   ORDER BY COALESCE(n.value->>'device_id', o.value->>'device_id')::uuid)
    INTO ids
    FROM old_data o FULL JOIN new_data n USING (row_key)
   WHERE (o.value - excluded) IS DISTINCT FROM (n.value - excluded);
  PERFORM public.breeze_partner_export_touch_devices(
    ids,
    TG_TABLE_NAME <> 'software_inventory',
    TG_TABLE_NAME = 'software_inventory',
    TG_TABLE_NAME IN ('device_network', 'device_ip_history', 'hyperv_vms')
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'site_id')::uuid ORDER BY (to_jsonb(row)->>'site_id')::uuid)
    INTO ids FROM new_rows row;
  PERFORM public.breeze_partner_export_touch_sites(ids, TG_TABLE_NAME <> 'network_topology', TG_TABLE_NAME = 'network_topology');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'site_id')::uuid ORDER BY (to_jsonb(row)->>'site_id')::uuid)
    INTO ids FROM old_rows row;
  PERFORM public.breeze_partner_export_touch_sites(ids, TG_TABLE_NAME <> 'network_topology', TG_TABLE_NAME = 'network_topology');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; excluded text[];
BEGIN
  excluded := CASE TG_TABLE_NAME
    WHEN 'discovered_assets' THEN ARRAY['is_online', 'approved_by', 'approved_at', 'dismissed_by', 'dismissed_at', 'open_ports', 'os_fingerprint', 'snmp_data', 'response_time_ms', 'last_seen_at', 'last_job_id', 'discovery_methods', 'notes', 'tags', 'updated_at']
    WHEN 'network_baselines' THEN ARRAY['last_scan_at', 'last_scan_job_id', 'known_devices', 'scan_schedule', 'alert_settings', 'updated_at']
    WHEN 'network_topology' THEN ARRAY['bandwidth', 'latency', 'method', 'confidence', 'created_by', 'first_seen_at', 'last_verified_at', 'updated_at']
    ELSE ARRAY[]::text[]
  END;
  WITH old_data AS (
    SELECT to_jsonb(row)->>'id' AS row_key, to_jsonb(row) AS value FROM old_rows row
  ), new_data AS (
    SELECT to_jsonb(row)->>'id' AS row_key, to_jsonb(row) AS value FROM new_rows row
  )
  SELECT array_agg(DISTINCT COALESCE(n.value->>'site_id', o.value->>'site_id')::uuid
                   ORDER BY COALESCE(n.value->>'site_id', o.value->>'site_id')::uuid)
    INTO ids
    FROM old_data o FULL JOIN new_data n USING (row_key)
   WHERE (o.value - excluded) IS DISTINCT FROM (n.value - excluded);
  PERFORM public.breeze_partner_export_touch_sites(ids, TG_TABLE_NAME <> 'network_topology', TG_TABLE_NAME = 'network_topology');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_relationship_owner_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; groups uuid[];
BEGIN
  WITH changed AS (
    SELECT o.id, o.link_group_id old_group, n.link_group_id new_group
    FROM old_rows o JOIN new_rows n USING (id)
    WHERE ROW(o.org_id, o.site_id, o.link_group_id, o.link_group_role)
       IS DISTINCT FROM ROW(n.org_id, n.site_id, n.link_group_id, n.link_group_role)
  )
  SELECT array_agg(DISTINCT id ORDER BY id),
         array_agg(DISTINCT group_id ORDER BY group_id) FILTER (WHERE group_id IS NOT NULL)
    INTO ids, groups
    FROM changed CROSS JOIN LATERAL (VALUES(old_group), (new_group)) group_ids(group_id);
  SELECT array_agg(DISTINCT id ORDER BY id) INTO ids
  FROM (
    SELECT unnest(COALESCE(ids, ARRAY[]::uuid[])) id
    UNION
    SELECT d.id FROM public.devices d WHERE d.link_group_id = ANY(COALESCE(groups, ARRAY[]::uuid[]))
  ) affected;
  PERFORM public.breeze_partner_export_touch_devices(ids, false, false, true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_relationship_owner_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; groups uuid[];
BEGIN
  SELECT array_agg(DISTINCT link_group_id ORDER BY link_group_id) FILTER (WHERE link_group_id IS NOT NULL)
    INTO groups FROM old_rows;
  SELECT array_agg(DISTINCT d.id ORDER BY d.id) INTO ids
    FROM public.devices d WHERE d.link_group_id = ANY(COALESCE(groups, ARRAY[]::uuid[]));
  PERFORM public.breeze_partner_export_touch_devices(ids, false, false, true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_owner_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT n.id ORDER BY n.id) INTO ids
  FROM old_rows o JOIN new_rows n USING (id) WHERE o.org_id IS DISTINCT FROM n.org_id;
  PERFORM public.breeze_partner_export_touch_sites(ids, true, true);
  RETURN NULL;
END;
$$;

-- Material-state ownership and clocks are database-owned. Direct app writes
-- keep their existing values; nested trusted child triggers may advance them.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_guard_device_material_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT d.org_id, d.partner_export_updated_at, d.partner_export_updated_at, d.partner_export_updated_at
      INTO NEW.org_id, NEW.inventory_updated_at, NEW.software_updated_at, NEW.relationships_updated_at
      FROM public.devices d WHERE d.id = NEW.device_id;
  ELSE
    NEW.org_id := OLD.org_id;
    NEW.inventory_updated_at := OLD.inventory_updated_at;
    NEW.software_updated_at := OLD.software_updated_at;
    NEW.relationships_updated_at := OLD.relationships_updated_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_guard_site_material_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.org_id, s.partner_export_updated_at, s.partner_export_updated_at
      INTO NEW.org_id, NEW.inventory_updated_at, NEW.relationships_updated_at
      FROM public.sites s WHERE s.id = NEW.site_id;
  ELSE
    NEW.org_id := OLD.org_id;
    NEW.inventory_updated_at := OLD.inventory_updated_at;
    NEW.relationships_updated_at := OLD.relationships_updated_at;
  END IF;
  RETURN NEW;
END;
$$;

-- Install statement triggers. Re-application replaces each trigger cleanly.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'device_hardware', 'device_disks', 'device_network', 'device_ip_history',
    'software_inventory', 'device_warranty', 'hyperv_vms'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_material_insert ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_material_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_device_child_insert()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_material_update ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_material_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_device_child_update()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_material_delete ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_material_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_device_child_delete()', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['discovered_assets', 'network_baselines', 'network_topology']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_material_insert ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_material_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_site_child_insert()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_material_update ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_material_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_site_child_update()', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS breeze_partner_export_material_delete ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER breeze_partner_export_material_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_site_child_delete()', table_name);
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_relationship_owner_update ON public.devices;
CREATE TRIGGER breeze_partner_export_relationship_owner_update
AFTER UPDATE ON public.devices REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_device_relationship_owner_update();

DROP TRIGGER IF EXISTS breeze_partner_export_relationship_owner_delete ON public.devices;
CREATE TRIGGER breeze_partner_export_relationship_owner_delete
AFTER DELETE ON public.devices REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_device_relationship_owner_delete();

DROP TRIGGER IF EXISTS breeze_partner_export_material_owner_update ON public.sites;
CREATE TRIGGER breeze_partner_export_material_owner_update
AFTER UPDATE ON public.sites REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_site_owner_update();

DROP TRIGGER IF EXISTS breeze_partner_export_guard_direct_write ON public.partner_export_device_material_state;
CREATE TRIGGER breeze_partner_export_guard_direct_write
BEFORE INSERT OR UPDATE ON public.partner_export_device_material_state
FOR EACH ROW WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION public.breeze_partner_export_guard_device_material_state();

DROP TRIGGER IF EXISTS breeze_partner_export_guard_direct_write ON public.partner_export_site_material_state;
CREATE TRIGGER breeze_partner_export_guard_direct_write
BEFORE INSERT OR UPDATE ON public.partner_export_site_material_state
FOR EACH ROW WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION public.breeze_partner_export_guard_site_material_state();

CREATE INDEX IF NOT EXISTS discovered_assets_partner_export_site_idx
  ON public.discovered_assets(org_id, site_id, id)
  WHERE approval_status = 'approved' AND asset_type IN ('router', 'switch', 'firewall', 'access_point', 'nas');
CREATE INDEX IF NOT EXISTS network_topology_partner_export_site_idx
  ON public.network_topology(org_id, site_id, id);

REVOKE ALL ON FUNCTION public.breeze_partner_export_touch_devices(uuid[], boolean, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_touch_sites(uuid[], boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_device_child_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_device_child_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_device_child_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_child_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_child_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_child_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_device_relationship_owner_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_device_relationship_owner_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_owner_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_guard_device_material_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_guard_site_material_state() FROM PUBLIC;
