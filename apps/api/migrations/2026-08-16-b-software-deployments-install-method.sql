-- Manager-linked deployments: a software_deployment now targets EITHER an
-- uploaded/URL version (software_version_id) OR a package-manager install
-- method (install_method_id). Exactly one is set
-- (software_deployments_one_target_chk).
--
-- Depends on 2026-08-16-a-software-install-methods.sql (the FK target), hence
-- the -b- same-day infix.
--
-- No ON DELETE action on the new FK, mirroring the existing
-- software_version_id FK: a deployment must keep pointing at a real target
-- row. software_install_methods itself cascades from software_catalog, so an
-- org erasure removes deployments (org cascade) before the catalog rows.
--
-- Export policy: install_method_id is classified 'included' (a tenant row
-- identifier, no secret material) in CORE_TENANT_EXPORT_POLICY in this same
-- PR — every column of an org-cascade table must be classified.
--
-- Idempotent: IF NOT EXISTS + guarded DO block; re-applying is a no-op.

ALTER TABLE software_deployments
  ADD COLUMN IF NOT EXISTS install_method_id uuid REFERENCES software_install_methods(id);

ALTER TABLE software_deployments
  ALTER COLUMN software_version_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE software_deployments
    ADD CONSTRAINT software_deployments_one_target_chk
    CHECK ((software_version_id IS NULL) <> (install_method_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS software_deployments_install_method_idx
  ON software_deployments (install_method_id);
