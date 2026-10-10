-- Physical placement and circuits V1, Wave 1-A: asset_physical_placements.
--
-- Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
--       (§5.1 data model, §7 authorization/tenancy, §12 registrations)
-- Discussion #8134.
--
-- One authoritative placement (room / rack / rack unit / height U) per network
-- asset. The subject is EITHER a managed device OR a discovered asset, never
-- both and never neither. No site_id is stored: the site is derived live from
-- the subject so a same-org site move needs no rewrite (spec D3).
--
-- Tenancy shape 1 (direct org_id NOT NULL). Both subject FKs are composite
-- (subject_id, org_id) -> parent(id, org_id) and DEFERRABLE INITIALLY IMMEDIATE,
-- so a cross-org subject is unrepresentable and org merge can defer them.
-- devices(id, org_id) and discovered_assets(id, org_id) uniques already exist
-- (devices_id_org_id_uniq, discovered_assets_id_org_id_uniq).
--
-- The column is named device_id on purpose: the placement follows its device,
-- so the device-move org re-stamp and the device cascade lists must see it.
-- ON UPDATE CASCADE carries a device org move onto the row (same as
-- device_memory_modules). This table is not partner-export material state, so
-- it deliberately has no breeze_partner_export_material_* triggers.
--
-- DDL only: no INSERT/UPDATE/DELETE, so no set_config('breeze.scope', ...)
-- preamble. Idempotent; no inner BEGIN/COMMIT.
--
-- Rollback: a new migration dropping the table. Nothing else reads it yet.

CREATE TABLE IF NOT EXISTS asset_physical_placements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL
    CONSTRAINT asset_physical_placements_org_id_organizations_id_fk REFERENCES organizations(id),
  device_id           uuid,
  discovered_asset_id uuid,
  room                varchar(255),
  rack                varchar(128),
  rack_unit           integer,
  height_u            integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asset_physical_placements_one_subject_chk
    CHECK (num_nonnulls(device_id, discovered_asset_id) = 1),
  CONSTRAINT asset_physical_placements_rack_unit_chk
    CHECK (rack_unit IS NULL OR rack_unit BETWEEN 1 AND 100),
  CONSTRAINT asset_physical_placements_height_u_chk
    CHECK (height_u IS NULL OR height_u BETWEEN 1 AND 100),
  -- An empty placement is never persisted (spec §5.1): deleting the last value
  -- deletes the row.
  CONSTRAINT asset_physical_placements_not_empty_chk
    CHECK (num_nonnulls(room, rack, rack_unit, height_u) >= 1)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'asset_physical_placements_device_org_fk'
       AND conrelid = 'public.asset_physical_placements'::regclass
  ) THEN
    ALTER TABLE asset_physical_placements
      ADD CONSTRAINT asset_physical_placements_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'asset_physical_placements_discovered_asset_org_fk'
       AND conrelid = 'public.asset_physical_placements'::regclass
  ) THEN
    ALTER TABLE asset_physical_placements
      ADD CONSTRAINT asset_physical_placements_discovered_asset_org_fk
      FOREIGN KEY (discovered_asset_id, org_id) REFERENCES discovered_assets(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- One placement per physical subject.
CREATE UNIQUE INDEX IF NOT EXISTS asset_physical_placements_device_uniq
  ON asset_physical_placements(device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS asset_physical_placements_discovered_asset_uniq
  ON asset_physical_placements(discovered_asset_id) WHERE discovered_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS asset_physical_placements_org_id_idx
  ON asset_physical_placements(org_id);

ALTER TABLE asset_physical_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_physical_placements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON asset_physical_placements;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON asset_physical_placements;
DROP POLICY IF EXISTS breeze_org_isolation_update ON asset_physical_placements;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON asset_physical_placements;
CREATE POLICY breeze_org_isolation_select ON asset_physical_placements
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON asset_physical_placements
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON asset_physical_placements
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON asset_physical_placements
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_physical_placements TO breeze_app;
