-- Software catalog: add a partner axis so built-in (integration) packages are
-- defined once per partner, while existing custom packages stay org-scoped.
-- Exactly one of (org_id, partner_id) is set. Dual-axis RLS like users/configuration_policies.

ALTER TABLE software_catalog
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE software_catalog
  ADD COLUMN IF NOT EXISTS integration_provider varchar(20);

-- org_id was NOT NULL; partner-scoped built-ins must allow NULL org_id.
ALTER TABLE software_catalog
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_catalog_one_owner_chk'
      AND conrelid = 'software_catalog'::regclass
  ) THEN
    ALTER TABLE software_catalog
      ADD CONSTRAINT software_catalog_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_catalog_partner_id_idx
  ON software_catalog(partner_id);
CREATE INDEX IF NOT EXISTS software_catalog_partner_provider_idx
  ON software_catalog(partner_id, integration_provider);

-- One built-in package per (partner, provider).
CREATE UNIQUE INDEX IF NOT EXISTS software_catalog_partner_provider_unique_idx
  ON software_catalog(partner_id, integration_provider)
  WHERE integration_provider IS NOT NULL;

-- Dual-axis RLS: org members see org packages; partner admins see partner built-ins.
-- Drop the baseline org-only policies (from 0001-baseline.sql) so they don't linger
-- alongside the new dual-axis policies.
DROP POLICY IF EXISTS breeze_org_isolation_select ON software_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_catalog;

DROP POLICY IF EXISTS software_catalog_dual_isolation_select ON software_catalog;
DROP POLICY IF EXISTS software_catalog_dual_isolation_insert ON software_catalog;
DROP POLICY IF EXISTS software_catalog_dual_isolation_update ON software_catalog;
DROP POLICY IF EXISTS software_catalog_dual_isolation_delete ON software_catalog;

ALTER TABLE software_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_catalog FORCE ROW LEVEL SECURITY;

CREATE POLICY software_catalog_dual_isolation_select ON software_catalog
  FOR SELECT USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_catalog_dual_isolation_insert ON software_catalog
  FOR INSERT WITH CHECK (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_catalog_dual_isolation_update ON software_catalog
  FOR UPDATE USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_catalog_dual_isolation_delete ON software_catalog
  FOR DELETE USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
