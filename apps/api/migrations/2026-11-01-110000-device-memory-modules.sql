-- #5351 — per-slot memory module inventory.
--
-- Spec: docs/superpowers/specs/device-lifecycle/2026-09-26-memory-modules-design.md
--
-- 1. Four nullable summary columns on device_hardware (slot count, max
--    capacity, on-package flag, when a valid memory block was last applied).
-- 2. New device child table device_memory_modules — tenancy shape 5 with a
--    denormalized org_id, one row per physical slot (populated or empty),
--    RLS enabled + forced + the four org policies.
-- 3. Partner-export material statement triggers on the new table, reusing the
--    shared device-child INSERT/DELETE functions (latest bodies:
--    2026-10-14-100200-device-warranty-manual-asset-subject.sql) unchanged.
-- 4. The device-child UPDATE trigger function (latest body:
--    2026-10-28-100000-partner-export-child-update-lock-on-change.sql) is
--    replayed verbatim with two additions to its excluded-column map:
--      * device_memory_modules -> updated_at. The ingest updates every
--        matched row's updated_at on each report, so without this an
--        unchanged report would take the exclusive org lock (#6698).
--      * device_hardware -> memory_observed_at. It is stamped on every report
--        that carries a valid memory block, and the partner export does not
--        publish it; left material, every such hardware report would take the
--        exclusive org lock and advance the inventory watermark for nothing.
--    The change filter still runs before the lock.
--
-- Writes no rows, so no `set_config('breeze.scope', 'system', true)` is
-- needed. Fully idempotent: integration suites replay it (replayMigration
-- follows any later migration that redefines the device-child functions).

ALTER TABLE public.device_hardware ADD COLUMN IF NOT EXISTS memory_slots_total integer;
ALTER TABLE public.device_hardware ADD COLUMN IF NOT EXISTS memory_max_capacity_mb integer;
ALTER TABLE public.device_hardware ADD COLUMN IF NOT EXISTS memory_soldered boolean;
ALTER TABLE public.device_hardware ADD COLUMN IF NOT EXISTS memory_observed_at timestamp;

CREATE TABLE IF NOT EXISTS public.device_memory_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL
    CONSTRAINT device_memory_modules_device_id_devices_id_fk REFERENCES public.devices(id),
  org_id uuid NOT NULL
    CONSTRAINT device_memory_modules_org_id_organizations_id_fk REFERENCES public.organizations(id),
  slot_key varchar(160) NOT NULL,
  slot_index integer NOT NULL,
  locator varchar(128) NOT NULL,
  bank_label varchar(128),
  populated boolean NOT NULL,
  capacity_mb integer,
  memory_type varchar(32),
  form_factor varchar(32),
  speed_mts integer,
  configured_speed_mts integer,
  manufacturer varchar(128),
  part_number varchar(128),
  serial_number varchar(128),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Composite same-org FK. DEFERRABLE INITIALLY IMMEDIATE is mandatory for every
-- composite FK referencing an org_id column: org merge runs
-- SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements. ON UPDATE CASCADE carries a device move's org_id onto
-- the rows; ON DELETE CASCADE because a module row is meaningless without its
-- device (the explicit device cascade list deletes it first anyway).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'device_memory_modules_device_org_fk'
       AND conrelid = 'public.device_memory_modules'::regclass
  ) THEN
    ALTER TABLE public.device_memory_modules
      ADD CONSTRAINT device_memory_modules_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES public.devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- One row per slot per device. Also serves every device_id lookup (read
-- route, sync, cascade) as the leading column.
CREATE UNIQUE INDEX IF NOT EXISTS device_memory_modules_device_slot_key_uniq
  ON public.device_memory_modules(device_id, slot_key);
CREATE INDEX IF NOT EXISTS device_memory_modules_org_id_idx
  ON public.device_memory_modules(org_id);

ALTER TABLE public.device_memory_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_memory_modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_memory_modules;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_memory_modules;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_memory_modules;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_memory_modules;
CREATE POLICY breeze_org_isolation_select ON public.device_memory_modules
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_memory_modules
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_memory_modules
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_memory_modules
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.device_memory_modules TO breeze_app;
  END IF;
END $$;

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
    WHEN 'device_hardware' THEN ARRAY['updated_at', 'partner_export_updated_at', 'memory_observed_at']
    WHEN 'device_disks' THEN ARRAY['used_gb', 'free_gb', 'used_percent', 'health', 'updated_at']
    WHEN 'device_network' THEN ARRAY['ip_address', 'ip_type', 'public_ip', 'updated_at']
    WHEN 'device_ip_history' THEN ARRAY['last_seen', 'updated_at']
    WHEN 'software_inventory' THEN ARRAY['catalog_id', 'install_location', 'uninstall_string', 'last_seen', 'file_hash', 'hash_algorithm']
    WHEN 'device_warranty' THEN ARRAY['manufacturer', 'serial_number', 'entitlements', 'data_source', 'last_sync_at', 'last_sync_error', 'next_sync_at', 'updated_at']
    WHEN 'hyperv_vms' THEN ARRAY['state', 'vhd_paths', 'checkpoints', 'notes', 'last_discovered_at', 'updated_at']
    WHEN 'device_memory_modules' THEN ARRAY['updated_at']
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

-- Material statement triggers. Literal targets (not a FOREACH loop) so the
-- migration lock-contract scanner (db/migrationPartnerExportLocks.test.ts)
-- and the replay fixture's trigger scan both see the table.
DROP TRIGGER IF EXISTS breeze_partner_export_material_insert ON public.device_memory_modules;
CREATE TRIGGER breeze_partner_export_material_insert AFTER INSERT ON public.device_memory_modules
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_partner_export_device_child_insert();
DROP TRIGGER IF EXISTS breeze_partner_export_material_update ON public.device_memory_modules;
CREATE TRIGGER breeze_partner_export_material_update AFTER UPDATE ON public.device_memory_modules
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_partner_export_device_child_update();
DROP TRIGGER IF EXISTS breeze_partner_export_material_delete ON public.device_memory_modules;
CREATE TRIGGER breeze_partner_export_material_delete AFTER DELETE ON public.device_memory_modules
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_partner_export_device_child_delete();
