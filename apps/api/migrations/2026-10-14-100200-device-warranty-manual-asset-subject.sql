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
