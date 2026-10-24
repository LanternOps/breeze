-- #6958 PR C. Additive DDL only; no rows written.
--
-- software_catalog.builtin_package_key marks a Breeze-defined package row
-- (e.g. 'controld_windows'). It is partner-owned only (never an org row) and
-- unique per partner. Built-in rows are immutable outside system scope; the
-- route guards enforce that alongside integration_provider.
--
-- software_versions.install_scripts_enabled gates whether a version's stored
-- pre/post-install scripts are dispatched. Default false, so scripts stored
-- before this column existed stay dormant until the version is re-created by
-- a writer holding devices.execute (or by the built-in seeder).
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE software_catalog ADD COLUMN IF NOT EXISTS builtin_package_key varchar(40);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'software_catalog_builtin_package_key_chk') THEN
    ALTER TABLE software_catalog ADD CONSTRAINT software_catalog_builtin_package_key_chk CHECK (
      builtin_package_key IS NULL OR (
        partner_id IS NOT NULL AND org_id IS NULL
        AND builtin_package_key ~ '^[a-z][a-z0-9_]{1,39}$'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS software_catalog_partner_builtin_key_uidx
  ON software_catalog (partner_id, builtin_package_key) WHERE builtin_package_key IS NOT NULL;

-- Stored-but-never-run scripts stay dormant: only a writer holding
-- devices.execute (or the built-in seeder) can enable them.
ALTER TABLE software_versions ADD COLUMN IF NOT EXISTS install_scripts_enabled boolean NOT NULL DEFAULT false;
