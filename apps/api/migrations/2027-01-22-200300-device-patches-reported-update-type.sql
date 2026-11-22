-- #11073 (feature #11065): what THIS device says a pending Windows Update is.
--
-- Breeze patch jobs leave a driver or firmware update to a vendor lane only where
-- that lane is really delivering it (spec 4.6), and the shared patches row cannot
-- say which updates those are: it carries only `category`, and it is deduped across
-- every tenant, so one tenant's agent report must not influence another's jobs.
-- This column sits on the device's own row instead.
--
--   'driver'     - a WUA driver update (IUpdate.Type = 2)
--   'firmware'   - a WUA driver update that writes firmware
--   'quality'    - security, critical, service pack or update rollup
--   'feature'    - a Windows feature release or feature pack
--   'definition' - a definition update
--   'other'      - anything else Windows Update offers
--   NULL         - not reported: an older agent, a provider that is not Windows
--                  Update, or every row written before this migration
--
-- These are category.go's classifications, reduced to what this rule needs. NULL
-- is the safe reading: a NULL row is never left to a vendor lane.
--
-- reported_update_owner is the vendor lane whose own update this is, from the
-- driver's manufacturer. A lane only delivers its vendor's updates, so an Intel
-- driver on a Surface or a printer driver on a Dell has no owner (NULL) and stays
-- with Windows Update whatever the lane is doing.
--
-- Adding nullable columns with no default is metadata-only: no rewrite, no row
-- writes, so this file elects no system scope.
ALTER TABLE device_patches ADD COLUMN IF NOT EXISTS reported_update_type varchar(16);
ALTER TABLE device_patches ADD COLUMN IF NOT EXISTS reported_update_owner varchar(16);

DO $$ BEGIN
  ALTER TABLE device_patches
    ADD CONSTRAINT device_patches_reported_update_type_chk
    CHECK (reported_update_type IS NULL OR reported_update_type IN ('driver', 'firmware', 'quality', 'feature', 'definition', 'other'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE device_patches
    ADD CONSTRAINT device_patches_reported_update_owner_chk
    CHECK (reported_update_owner IS NULL OR reported_update_owner IN ('dell', 'surface', 'hp', 'lenovo'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;
