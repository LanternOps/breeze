-- 2026-04-11: Bucket C Phase 1 — HOT inventory cluster RLS.
--
-- Adds `org_id` columns (denormalized from `devices.org_id`) and full RLS
-- coverage to the five tables that are written on every agent heartbeat
-- or inventory sync. These are the highest-frequency device-scoped
-- tables in the schema; a join-through policy would add a `devices`
-- lookup to every row evaluation, so we denormalize the column and use
-- the standard breeze_has_org_access(org_id) policies instead.
--
-- Tables:
--   - device_hardware       (one row per device, upsert on every sync)
--   - device_disks          (delete+reinsert on every sync)
--   - device_network        (delete+reinsert on every sync)
--   - software_inventory    (delete+reinsert on every sync)
--   - device_connections    (delete+reinsert on every sync)
--
-- All five are written from apps/api/src/routes/agents/inventory.ts and
-- apps/api/src/routes/agents/connections.ts. Each handler already has
-- the `devices` row in scope at write time (it looks the device up by
-- agent id as part of auth), so the app-layer write-site updates just
-- need to propagate `org_id` from the device row into the values
-- object. That change ships in the same commit.
--
-- Backfill strategy: UPDATE ... FROM devices d WHERE d.id = <table>.device_id,
-- then SET NOT NULL. Trivial because `device_id` is already NOT NULL
-- on every row on every table.
--
-- Fully idempotent.

BEGIN;

-- ============================================================
-- Helper: add org_id column, backfill, NOT NULL, FK, RLS + policies
-- ============================================================
-- Pattern repeated 5 times because PL/pgSQL dynamic SQL for each table
-- would obscure the intent and make the migration harder to audit.

-- -------- device_hardware --------
ALTER TABLE device_hardware ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_hardware SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_hardware.device_id
   AND device_hardware.org_id IS NULL;
ALTER TABLE device_hardware ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_hardware_org_id_organizations_id_fk') THEN
    ALTER TABLE device_hardware ADD CONSTRAINT device_hardware_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_hardware;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_hardware;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_hardware;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_hardware;
ALTER TABLE device_hardware ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_hardware FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_hardware
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_hardware
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_hardware
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_hardware
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_disks --------
ALTER TABLE device_disks ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_disks SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_disks.device_id
   AND device_disks.org_id IS NULL;
ALTER TABLE device_disks ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_disks_org_id_organizations_id_fk') THEN
    ALTER TABLE device_disks ADD CONSTRAINT device_disks_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_disks;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_disks;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_disks;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_disks;
ALTER TABLE device_disks ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_disks FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_disks
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_disks
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_disks
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_disks
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_network --------
ALTER TABLE device_network ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_network SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_network.device_id
   AND device_network.org_id IS NULL;
ALTER TABLE device_network ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_network_org_id_organizations_id_fk') THEN
    ALTER TABLE device_network ADD CONSTRAINT device_network_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_network;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_network;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_network;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_network;
ALTER TABLE device_network ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_network FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_network
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_network
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_network
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_network
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- software_inventory --------
ALTER TABLE software_inventory ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE software_inventory SET org_id = d.org_id
  FROM devices d
 WHERE d.id = software_inventory.device_id
   AND software_inventory.org_id IS NULL;
ALTER TABLE software_inventory ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'software_inventory_org_id_organizations_id_fk') THEN
    ALTER TABLE software_inventory ADD CONSTRAINT software_inventory_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_inventory;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_inventory;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_inventory;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_inventory;
ALTER TABLE software_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_inventory FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON software_inventory
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON software_inventory
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON software_inventory
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON software_inventory
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_connections --------
ALTER TABLE device_connections ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_connections SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_connections.device_id
   AND device_connections.org_id IS NULL;
ALTER TABLE device_connections ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_connections_org_id_organizations_id_fk') THEN
    ALTER TABLE device_connections ADD CONSTRAINT device_connections_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_connections;
ALTER TABLE device_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_connections
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_connections
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_connections
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_connections
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
