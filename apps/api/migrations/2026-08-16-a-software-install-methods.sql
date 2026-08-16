-- Package-manager install methods for software_catalog items (spec:
-- docs/superpowers/specs/vuln-patch/2026-08-15-package-manager-software-library-design.md).
--
-- One row per (catalog item, platform, kind): a winget package ID or a
-- Homebrew formula/cask name that can install this library item. Version
-- intent (latest vs exact) lives on the deployment, not here.
--
-- Tenancy: parent-FK join shape — no org_id/partner_id; RLS policies
-- EXISTS-join to software_catalog (template: software_versions policies in
-- 2026-07-02-builtin-catalog-partner-read-rls.sql). Registered in
-- PARENT_FK_JOIN_POLICY_TABLES; NOT in the org cascade order (FK CASCADE +
-- topologicalCascadeOrder handle deletion), so no export-policy entry.
--
-- Idempotent: IF NOT EXISTS + guarded DO blocks + DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS software_install_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL REFERENCES software_catalog(id) ON DELETE CASCADE,
  platform varchar(10) NOT NULL,
  kind varchar(20) NOT NULL,
  package_id varchar(256) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE software_install_methods
    ADD CONSTRAINT software_install_methods_platform_chk
    CHECK (platform IN ('windows', 'macos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE software_install_methods
    ADD CONSTRAINT software_install_methods_kind_chk
    CHECK (kind IN ('winget', 'homebrew_cask', 'homebrew_formula'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Platform/kind coherence: winget is Windows-only, homebrew is macOS-only.
DO $$ BEGIN
  ALTER TABLE software_install_methods
    ADD CONSTRAINT software_install_methods_platform_kind_chk
    CHECK (
      (kind = 'winget' AND platform = 'windows')
      OR (kind IN ('homebrew_cask', 'homebrew_formula') AND platform = 'macos')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS software_install_methods_catalog_platform_kind_uq
  ON software_install_methods (catalog_id, platform, kind);
CREATE INDEX IF NOT EXISTS software_install_methods_catalog_id_idx
  ON software_install_methods (catalog_id);

ALTER TABLE software_install_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_install_methods FORCE ROW LEVEL SECURITY;

-- SELECT carries the built-in third branch mirroring software_versions
-- (2026-07-02); writes carry only org + partner branches. v1 never creates
-- methods on built-in rows (app-layer guard), but read parity keeps the two
-- child tables' policies interchangeable.
DROP POLICY IF EXISTS breeze_org_isolation_select ON software_install_methods;
CREATE POLICY breeze_org_isolation_select ON software_install_methods FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
        OR (
          sc.integration_provider IS NOT NULL
          AND sc.partner_id IN (
            SELECT o.partner_id FROM organizations o
            WHERE o.id = ANY(public.breeze_accessible_org_ids())
          )
        )
      )
  )
);
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_install_methods;
CREATE POLICY breeze_org_isolation_insert ON software_install_methods FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_install_methods;
CREATE POLICY breeze_org_isolation_update ON software_install_methods FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_install_methods;
CREATE POLICY breeze_org_isolation_delete ON software_install_methods FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
