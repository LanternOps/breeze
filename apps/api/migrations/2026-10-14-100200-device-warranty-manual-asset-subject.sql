-- #4622 W03 — device_warranty gains an XOR subject so a manual asset can carry
-- warranty data. The provider layer is already subject-agnostic; only the
-- subject binding was device-shaped.
--
-- Writes no rows, so no `SELECT set_config('breeze.scope','system',true)` is
-- needed. (The XOR CHECK below is added without a cleanup pass because every
-- existing row has device_id NOT NULL / manual_asset_id NULL, which satisfies
-- it. If it ever fails to validate that is real data to investigate — do not
-- add a silent UPDATE.)

-- The composite same-org FK below references (id, org_id) on manual_assets, so
-- that pair must be unique. `id` is already the PK; this makes the composite
-- referenceable. Cheap: manual_assets shipped in the previous migration.
CREATE UNIQUE INDEX IF NOT EXISTS manual_assets_id_org_id_uniq
  ON manual_assets(id, org_id);

ALTER TABLE device_warranty ADD COLUMN IF NOT EXISTS manual_asset_id uuid;

-- Composite same-org FK: device_warranty carries org_id, so the link is pinned
-- to one tenant rather than merely to a row id. DEFERRABLE INITIALLY IMMEDIATE
-- is mandatory for every composite FK referencing an org_id column — org merge
-- runs SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements; a non-deferrable one aborts the merge with 23503.
DO $$ BEGIN
  ALTER TABLE device_warranty
    ADD CONSTRAINT device_warranty_manual_asset_fk
    FOREIGN KEY (manual_asset_id, org_id)
    REFERENCES manual_assets(id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS device_warranty_manual_asset_fk_idx
  ON device_warranty(manual_asset_id, org_id);

ALTER TABLE device_warranty ALTER COLUMN device_id DROP NOT NULL;

-- XOR subject, the pattern <table>_one_owner_chk already uses elsewhere.
ALTER TABLE device_warranty DROP CONSTRAINT IF EXISTS device_warranty_one_subject_chk;
ALTER TABLE device_warranty
  ADD CONSTRAINT device_warranty_one_subject_chk
  CHECK ((device_id IS NULL) <> (manual_asset_id IS NULL));

-- Both upsert conflict targets must stay valid, so the single unique index
-- becomes two partial ones. A NULL subject column must not collide with other
-- NULL subject columns, which a plain unique index over a nullable column would
-- permit but which would also make the conflict target ambiguous.
DROP INDEX IF EXISTS device_warranty_device_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS device_warranty_device_id_idx
  ON device_warranty(device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS device_warranty_manual_asset_id_idx
  ON device_warranty(manual_asset_id) WHERE manual_asset_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Fix forward: the partner-export material-state triggers assumed every
-- device-child row has a device_id.
--
-- `device_warranty` carries the `breeze_partner_export_material_insert/update`
-- statement triggers (2026-07-20 / hardened 2026-07-23). Their tenant-owner
-- check is `NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = row.device_id AND
-- d.org_id = row.org_id)`, which is TRUE for a NULL device_id — so the first
-- manual-subject warranty row raises 23503 'device child tenant owner does not
-- match device' before the XOR CHECK is ever consulted. Caught by
-- `deviceWarrantyManualSubject.integration.test.ts`; there is no unit-level
-- shape that could have seen it.
--
-- The guard is widened, never relaxed: a row WITH a device_id is still required
-- to match that device's org. Every other table wired to these functions has
-- device_id NOT NULL, so for them the new predicate is identical. NULL device
-- ids are also filtered out of the touch-list aggregates — a manual asset has
-- no device whose partner-export material state could change.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE (to_jsonb(row)->>'device_id') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.devices d
      WHERE d.id = (to_jsonb(row)->>'device_id')::uuid
        AND d.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'device child tenant owner does not match device'; END IF;
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'device_id')::uuid ORDER BY (to_jsonb(row)->>'device_id')::uuid)
    INTO ids FROM new_rows row WHERE (to_jsonb(row)->>'device_id') IS NOT NULL;
  PERFORM public.breeze_partner_export_touch_devices(ids, TG_TABLE_NAME <> 'software_inventory',
    TG_TABLE_NAME = 'software_inventory', TG_TABLE_NAME IN ('device_network', 'device_ip_history', 'hyperv_vms'));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_device_child_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (to_jsonb(row)->>'device_id')::uuid ORDER BY (to_jsonb(row)->>'device_id')::uuid)
    INTO ids FROM old_rows row WHERE (to_jsonb(row)->>'device_id') IS NOT NULL;
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
DECLARE ids uuid[]; org_ids uuid[]; excluded text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE (to_jsonb(row)->>'device_id') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.devices d
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
