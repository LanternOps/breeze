-- Complete the Breeze-owned reconstruction contract: pin every exported child
-- to its canonical tenant owner, cover old/new owner moves, and make material
-- state readable but not directly writable by the application role.

DO $$
DECLARE item record; mismatch_count bigint; mismatch_total bigint := 0;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('devices', 'site_id', 'sites', 'id'),
    ('device_hardware', 'device_id', 'devices', 'id'),
    ('device_disks', 'device_id', 'devices', 'id'),
    ('device_network', 'device_id', 'devices', 'id'),
    ('device_ip_history', 'device_id', 'devices', 'id'),
    ('software_inventory', 'device_id', 'devices', 'id'),
    ('device_warranty', 'device_id', 'devices', 'id'),
    ('hyperv_vms', 'device_id', 'devices', 'id'),
    ('discovered_assets', 'site_id', 'sites', 'id'),
    ('network_baselines', 'site_id', 'sites', 'id'),
    ('network_topology', 'site_id', 'sites', 'id'),
    ('partner_export_device_material_state', 'device_id', 'devices', 'id'),
    ('partner_export_site_material_state', 'site_id', 'sites', 'id')
  ) AS ownership(child_table, child_key, parent_table, parent_key)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I child LEFT JOIN public.%I parent ON parent.%I = child.%I WHERE parent.%I IS NULL OR parent.org_id IS DISTINCT FROM child.org_id',
      item.child_table, item.parent_table, item.parent_key, item.child_key, item.parent_key
    ) INTO mismatch_count;
    mismatch_total := mismatch_total + mismatch_count;
    IF mismatch_count > 0 THEN
      RAISE WARNING 'partner export ownership preflight found % inconsistent row(s) in %', mismatch_count, item.child_table;
    END IF;
  END LOOP;
  IF mismatch_total > 0 THEN
    RAISE EXCEPTION 'partner export ownership preflight failed with % inconsistent row(s)', mismatch_total;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS devices_id_org_id_uniq ON public.devices(id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS sites_id_org_id_uniq ON public.sites(id, org_id);

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('devices', 'devices_site_org_fk', 'site_id', 'sites', 'NO ACTION'),
    ('device_hardware', 'device_hardware_device_org_fk', 'device_id', 'devices', 'NO ACTION'),
    ('device_disks', 'device_disks_device_org_fk', 'device_id', 'devices', 'NO ACTION'),
    ('device_network', 'device_network_device_org_fk', 'device_id', 'devices', 'NO ACTION'),
    ('device_ip_history', 'device_ip_history_device_org_fk', 'device_id', 'devices', 'CASCADE'),
    ('software_inventory', 'software_inventory_device_org_fk', 'device_id', 'devices', 'NO ACTION'),
    ('device_warranty', 'device_warranty_device_org_fk', 'device_id', 'devices', 'CASCADE'),
    ('hyperv_vms', 'hyperv_vms_device_org_fk', 'device_id', 'devices', 'NO ACTION'),
    ('discovered_assets', 'discovered_assets_site_org_fk', 'site_id', 'sites', 'NO ACTION'),
    ('network_baselines', 'network_baselines_site_org_fk', 'site_id', 'sites', 'NO ACTION'),
    ('network_topology', 'network_topology_site_org_fk', 'site_id', 'sites', 'NO ACTION'),
    ('partner_export_device_material_state', 'partner_export_device_material_state_device_org_fk', 'device_id', 'devices', 'CASCADE'),
    ('partner_export_site_material_state', 'partner_export_site_material_state_site_org_fk', 'site_id', 'sites', 'CASCADE')
  ) AS ownership(child_table, constraint_name, child_key, parent_table, delete_action)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = item.constraint_name) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I, org_id) REFERENCES public.%I(id, org_id) ON UPDATE CASCADE ON DELETE %s DEFERRABLE INITIALLY DEFERRED NOT VALID',
        item.child_table, item.constraint_name, item.child_key, item.parent_table, item.delete_action
      );
    END IF;
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', item.child_table, item.constraint_name);
  END LOOP;
END $$;

-- Device enrollment supplies site_id and org_id atomically, so this edge does
-- not need deferred checking. Keep it immediate so a forged tuple fails at the
-- statement boundary (and is consistently wrapped by the query layer).
ALTER TABLE public.devices ALTER CONSTRAINT devices_site_org_fk NOT DEFERRABLE;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_stable_uuid(namespace text, source_identity text)
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
  FROM (SELECT md5(namespace || ':' || source_identity) AS value) digest;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE NOT EXISTS (SELECT 1 FROM public.devices d
      WHERE d.id = (to_jsonb(row)->>'device_id')::uuid
        AND d.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'device child tenant owner does not match device'; END IF;
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'device_id')::uuid ORDER BY (to_jsonb(row)->>'device_id')::uuid)
    INTO ids FROM new_rows row;
  PERFORM public.breeze_partner_export_touch_devices(ids, TG_TABLE_NAME <> 'software_inventory',
    TG_TABLE_NAME = 'software_inventory', TG_TABLE_NAME IN ('device_network', 'device_ip_history', 'hyperv_vms'));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; org_ids uuid[]; excluded text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE NOT EXISTS (SELECT 1 FROM public.devices d
      WHERE d.id = (to_jsonb(row)->>'device_id')::uuid
        AND d.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'device child tenant owner does not match device'; END IF;
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM (
    SELECT (to_jsonb(row)->>'org_id')::uuid org_id FROM old_rows row
    UNION SELECT (to_jsonb(row)->>'org_id')::uuid FROM new_rows row
  ) owners WHERE org_id IS NOT NULL;
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  excluded := CASE TG_TABLE_NAME
    WHEN 'device_hardware' THEN ARRAY['updated_at', 'partner_export_updated_at']
    WHEN 'device_disks' THEN ARRAY['used_gb', 'free_gb', 'used_percent', 'health', 'updated_at']
    WHEN 'device_network' THEN ARRAY['ip_address', 'ip_type', 'public_ip', 'updated_at']
    WHEN 'device_ip_history' THEN ARRAY['last_seen', 'updated_at']
    WHEN 'software_inventory' THEN ARRAY['catalog_id', 'install_location', 'uninstall_string', 'last_seen', 'file_hash', 'hash_algorithm']
    WHEN 'device_warranty' THEN ARRAY['manufacturer', 'serial_number', 'entitlements', 'data_source', 'last_sync_at', 'last_sync_error', 'next_sync_at', 'updated_at']
    WHEN 'hyperv_vms' THEN ARRAY['state', 'vhd_paths', 'checkpoints', 'notes', 'last_discovered_at', 'updated_at']
    ELSE ARRAY[]::text[] END;
  WITH old_data AS (
    SELECT COALESCE(to_jsonb(row)->>'id', to_jsonb(row)->>'device_id') row_key, to_jsonb(row) value FROM old_rows row
  ), new_data AS (
    SELECT COALESCE(to_jsonb(row)->>'id', to_jsonb(row)->>'device_id') row_key, to_jsonb(row) value FROM new_rows row
  ), changed AS (
    SELECT o.value old_value, n.value new_value FROM old_data o FULL JOIN new_data n USING (row_key)
    WHERE (o.value - excluded) IS DISTINCT FROM (n.value - excluded)
  )
  SELECT array_agg(DISTINCT owner_id ORDER BY owner_id) INTO ids
  FROM changed CROSS JOIN LATERAL (VALUES
    ((old_value->>'device_id')::uuid), ((new_value->>'device_id')::uuid)
  ) owners(owner_id) WHERE owner_id IS NOT NULL;
  PERFORM public.breeze_partner_export_touch_devices(ids, TG_TABLE_NAME <> 'software_inventory',
    TG_TABLE_NAME = 'software_inventory', TG_TABLE_NAME IN ('device_network', 'device_ip_history', 'hyperv_vms'));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE NOT EXISTS (SELECT 1 FROM public.sites s
      WHERE s.id = (to_jsonb(row)->>'site_id')::uuid
        AND s.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'site child tenant owner does not match site'; END IF;
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'site_id')::uuid ORDER BY (to_jsonb(row)->>'site_id')::uuid)
    INTO ids FROM new_rows row
   WHERE TG_TABLE_NAME <> 'discovered_assets' OR (
     to_jsonb(row)->>'approval_status' = 'approved'
     AND to_jsonb(row)->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas'));
  PERFORM public.breeze_partner_export_touch_sites(ids,
    TG_TABLE_NAME IN ('discovered_assets', 'network_baselines'),
    TG_TABLE_NAME IN ('discovered_assets', 'network_topology'));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'site_id')::uuid ORDER BY (to_jsonb(row)->>'site_id')::uuid)
    INTO ids FROM old_rows row
   WHERE TG_TABLE_NAME <> 'discovered_assets' OR (
     to_jsonb(row)->>'approval_status' = 'approved'
     AND to_jsonb(row)->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas'));
  PERFORM public.breeze_partner_export_touch_sites(ids,
    TG_TABLE_NAME IN ('discovered_assets', 'network_baselines'),
    TG_TABLE_NAME IN ('discovered_assets', 'network_topology'));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; org_ids uuid[]; excluded text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE NOT EXISTS (SELECT 1 FROM public.sites s
      WHERE s.id = (to_jsonb(row)->>'site_id')::uuid
        AND s.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'site child tenant owner does not match site'; END IF;
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM (
    SELECT (to_jsonb(row)->>'org_id')::uuid org_id FROM old_rows row
    UNION SELECT (to_jsonb(row)->>'org_id')::uuid FROM new_rows row
  ) owners WHERE org_id IS NOT NULL;
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  excluded := CASE TG_TABLE_NAME
    WHEN 'discovered_assets' THEN ARRAY['is_online', 'approved_by', 'approved_at', 'dismissed_by', 'dismissed_at', 'open_ports', 'os_fingerprint', 'snmp_data', 'response_time_ms', 'last_seen_at', 'last_job_id', 'discovery_methods', 'notes', 'tags', 'updated_at']
    WHEN 'network_baselines' THEN ARRAY['last_scan_at', 'last_scan_job_id', 'known_devices', 'scan_schedule', 'alert_settings', 'updated_at']
    WHEN 'network_topology' THEN ARRAY['bandwidth', 'latency', 'method', 'confidence', 'created_by', 'first_seen_at', 'last_verified_at', 'updated_at']
    ELSE ARRAY[]::text[] END;
  WITH old_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM old_rows row),
  new_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM new_rows row),
  changed AS (
    SELECT o.value old_value, n.value new_value FROM old_data o FULL JOIN new_data n USING (row_key)
    WHERE (o.value - excluded) IS DISTINCT FROM (n.value - excluded)
      AND (TG_TABLE_NAME <> 'discovered_assets' OR
        (o.value->>'approval_status' = 'approved' AND o.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')) OR
        (n.value->>'approval_status' = 'approved' AND n.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')))
  )
  SELECT array_agg(DISTINCT owner_id ORDER BY owner_id) INTO ids
  FROM changed CROSS JOIN LATERAL (VALUES
    ((old_value->>'site_id')::uuid), ((new_value->>'site_id')::uuid)
  ) owners(owner_id) WHERE owner_id IS NOT NULL;
  PERFORM public.breeze_partner_export_touch_sites(ids,
    TG_TABLE_NAME IN ('discovered_assets', 'network_baselines'),
    TG_TABLE_NAME IN ('discovered_assets', 'network_topology'));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_relationship_owner_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE owner_ids uuid[]; relationship_ids uuid[]; groups uuid[]; org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM (
    SELECT o.org_id FROM old_rows o JOIN new_rows n USING (id)
      WHERE ROW(o.org_id,o.site_id,o.link_group_id,o.link_group_role) IS DISTINCT FROM ROW(n.org_id,n.site_id,n.link_group_id,n.link_group_role)
    UNION SELECT n.org_id FROM old_rows o JOIN new_rows n USING (id)
      WHERE ROW(o.org_id,o.site_id,o.link_group_id,o.link_group_role) IS DISTINCT FROM ROW(n.org_id,n.site_id,n.link_group_id,n.link_group_role)
  ) changed_orgs;
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  SELECT array_agg(DISTINCT n.id ORDER BY n.id) INTO owner_ids FROM old_rows o JOIN new_rows n USING (id)
    WHERE ROW(o.org_id,o.site_id) IS DISTINCT FROM ROW(n.org_id,n.site_id);
  PERFORM public.breeze_partner_export_touch_devices(owner_ids, true, true, true);
  SELECT array_agg(DISTINCT group_id ORDER BY group_id) FILTER (WHERE group_id IS NOT NULL) INTO groups
    FROM old_rows o JOIN new_rows n USING (id)
    CROSS JOIN LATERAL (VALUES(o.link_group_id),(n.link_group_id)) group_values(group_id)
    WHERE ROW(o.org_id,o.site_id,o.link_group_id,o.link_group_role) IS DISTINCT FROM ROW(n.org_id,n.site_id,n.link_group_id,n.link_group_role);
  SELECT array_agg(DISTINCT id ORDER BY id) INTO relationship_ids FROM (
    SELECT n.id FROM old_rows o JOIN new_rows n USING (id)
      WHERE ROW(o.org_id,o.site_id,o.link_group_id,o.link_group_role) IS DISTINCT FROM ROW(n.org_id,n.site_id,n.link_group_id,n.link_group_role)
    UNION SELECT d.id FROM public.devices d WHERE d.link_group_id = ANY(COALESCE(groups, ARRAY[]::uuid[]))
  ) affected WHERE NOT id = ANY(COALESCE(owner_ids, ARRAY[]::uuid[]));
  PERFORM public.breeze_partner_export_touch_devices(relationship_ids, false, false, true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_owner_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM (
    SELECT o.org_id FROM old_rows o JOIN new_rows n USING (id) WHERE o.org_id IS DISTINCT FROM n.org_id
    UNION SELECT n.org_id FROM old_rows o JOIN new_rows n USING (id) WHERE o.org_id IS DISTINCT FROM n.org_id
  ) changed_orgs;
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  SELECT array_agg(DISTINCT n.id ORDER BY n.id) INTO ids FROM old_rows o JOIN new_rows n USING (id)
    WHERE o.org_id IS DISTINCT FROM n.org_id;
  PERFORM public.breeze_partner_export_touch_sites(ids, true, true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_guard_direct_write ON public.partner_export_device_material_state;
DROP TRIGGER IF EXISTS breeze_partner_export_guard_direct_write ON public.partner_export_site_material_state;
CREATE TRIGGER breeze_partner_export_guard_direct_write
BEFORE INSERT OR UPDATE ON public.partner_export_device_material_state
FOR EACH ROW WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION public.breeze_partner_export_guard_device_material_state();
CREATE TRIGGER breeze_partner_export_guard_direct_write
BEFORE INSERT OR UPDATE ON public.partner_export_site_material_state
FOR EACH ROW WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION public.breeze_partner_export_guard_site_material_state();
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.partner_export_device_material_state FROM breeze_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.partner_export_site_material_state FROM breeze_app;

REVOKE ALL ON FUNCTION public.breeze_partner_export_device_child_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_device_child_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_child_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_child_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_child_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_device_relationship_owner_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_site_owner_update() FROM PUBLIC;
