-- Partner-export child UPDATE triggers: take the exclusive per-org lock only
-- when the statement changed material state.
--
-- `breeze_partner_export_device_child_update` and `..._site_child_update`
-- took `breeze_partner_export_lock_orgs_exclusive` for every OLD/NEW org of
-- every updated row BEFORE filtering out the per-table `excluded` columns. So
-- a heartbeat's `UPDATE device_ip_history SET last_seen = ...` (or a disk
-- usage refresh, or a discovered_assets last_seen_at bump) serialised the
-- whole org behind one exclusive advisory lock even though it changes nothing
-- a partner export reconstructs. On 2026-09-22 that turned a pool-exhaustion
-- bug (#6671) into a full US outage: every same-org heartbeat queued on the
-- lock while holding a pooled connection.
--
-- What the lock protects: `breeze_partner_export_lock_orgs_shared_snapshot`
-- readers pick `snapshot_at` under shared org locks, and a writer's watermark
-- is drawn after its exclusive lock, so every material commit lands after any
-- open reader's snapshot. An update touching only excluded columns bumps no
-- watermark (`touch_*` receives no owners), and none of those columns are
-- exported, so skipping the lock for it cannot produce a missed or torn row.
--
-- Invariants kept:
-- * the tenant-owner validation still runs first, unconditionally;
-- * the lock set is the OLD and NEW org of every CHANGED row — `org_id` is
--   never in `excluded`, so an owner move (incl. the ON UPDATE CASCADE FK)
--   is always a change and still locks both orgs;
-- * the lock is taken whenever any row changed, even with no device/site id
--   (manual-subject device_warranty rows), and before `touch_*`, which takes
--   its own lock via the owner's current org.
-- INSERT/DELETE triggers keep their locking: row identity is exported.
--
-- Also: the site triggers' discovered_assets filter now includes approved
-- 'website' and 'service' assets. The partner export has published them
-- (url/label/source, routes/partnerApi/inventory.ts networkEquipment) since
-- 2026-10-14-100100, but the insert/update/delete triggers still listed only
-- the six scan equipment types, so edits to them never advanced the site
-- inventory watermark (incremental cursors could miss them). site_child_insert
-- and site_child_delete are replayed verbatim from
-- 2026-07-23-partner-export-material-state-hardening.sql with only that list
-- extended.
--
-- Bodies are replayed verbatim from their latest definitions
-- (device: 2026-10-14-100200-device-warranty-manual-asset-subject.sql,
-- site: 2026-10-15-150600-network-baseline-recurring-authority.sql) with only
-- the lock moved behind the change filter. Function DDL only — no row writes.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; org_ids uuid[]; excluded text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE (to_jsonb(row)->>'device_id') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.devices d
      WHERE d.id = (to_jsonb(row)->>'device_id')::uuid
        AND d.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'device child tenant owner does not match device'; END IF;
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
  SELECT
    (SELECT array_agg(DISTINCT owner_org ORDER BY owner_org) FROM changed CROSS JOIN LATERAL (VALUES
      ((old_value->>'org_id')::uuid), ((new_value->>'org_id')::uuid)
    ) orgs(owner_org) WHERE owner_org IS NOT NULL),
    (SELECT array_agg(DISTINCT owner_id ORDER BY owner_id) FROM changed CROSS JOIN LATERAL (VALUES
      ((old_value->>'device_id')::uuid), ((new_value->>'device_id')::uuid)
    ) owners(owner_id) WHERE owner_id IS NOT NULL)
  INTO org_ids, ids;
  -- Lock only when material state changed; OLD and NEW owner orgs of every
  -- changed row (org_id is never excluded, so an owner move always counts).
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  PERFORM public.breeze_partner_export_touch_devices(ids, TG_TABLE_NAME <> 'software_inventory',
    TG_TABLE_NAME = 'software_inventory', TG_TABLE_NAME IN ('device_network', 'device_ip_history', 'hyperv_vms'));
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
  excluded := CASE TG_TABLE_NAME
    WHEN 'discovered_assets' THEN ARRAY['is_online', 'approved_by', 'approved_at', 'dismissed_by', 'dismissed_at', 'open_ports', 'os_fingerprint', 'snmp_data', 'response_time_ms', 'last_seen_at', 'last_job_id', 'discovery_methods', 'notes', 'tags', 'updated_at']
    WHEN 'network_baselines' THEN ARRAY['last_scan_at', 'last_scan_job_id', 'known_devices', 'scan_schedule', 'alert_settings', 'updated_at', 'authority_user_id', 'authority_site_ids', 'authority_permissions_epoch', 'authority_mfa_epoch', 'authority_fingerprint', 'authority_generation', 'authority_armed_at', 'schedule_blocked_reason']
    WHEN 'network_topology' THEN ARRAY['bandwidth', 'latency', 'method', 'confidence', 'created_by', 'first_seen_at', 'last_verified_at', 'updated_at']
    ELSE ARRAY[]::text[] END;
  WITH old_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM old_rows row),
  new_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM new_rows row),
  changed AS (
    SELECT o.value old_value, n.value new_value FROM old_data o FULL JOIN new_data n USING (row_key)
    WHERE (o.value - excluded) IS DISTINCT FROM (n.value - excluded)
      AND (TG_TABLE_NAME <> 'discovered_assets' OR
        (o.value->>'approval_status' = 'approved' AND o.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas', 'website', 'service')) OR
        (n.value->>'approval_status' = 'approved' AND n.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas', 'website', 'service')))
  )
  SELECT
    (SELECT array_agg(DISTINCT owner_org ORDER BY owner_org) FROM changed CROSS JOIN LATERAL (VALUES
      ((old_value->>'org_id')::uuid), ((new_value->>'org_id')::uuid)
    ) orgs(owner_org) WHERE owner_org IS NOT NULL),
    (SELECT array_agg(DISTINCT owner_id ORDER BY owner_id) FROM changed CROSS JOIN LATERAL (VALUES
      ((old_value->>'site_id')::uuid), ((new_value->>'site_id')::uuid)
    ) owners(owner_id) WHERE owner_id IS NOT NULL)
  INTO org_ids, ids;
  -- Lock only when material state changed; OLD and NEW owner orgs of every
  -- changed row (org_id is never excluded, so an owner move always counts).
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  PERFORM public.breeze_partner_export_touch_sites(ids,
    TG_TABLE_NAME IN ('discovered_assets', 'network_baselines'),
    TG_TABLE_NAME IN ('discovered_assets', 'network_topology'));
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
     AND to_jsonb(row)->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas', 'website', 'service'));
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
     AND to_jsonb(row)->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas', 'website', 'service'));
  PERFORM public.breeze_partner_export_touch_sites(ids,
    TG_TABLE_NAME IN ('discovered_assets', 'network_baselines'),
    TG_TABLE_NAME IN ('discovered_assets', 'network_topology'));
  RETURN NULL;
END;
$$;
