-- Built-in EDR deployment packages (Huntress/SentinelOne) are partner-scoped:
-- org_id NULL, partner_id set, integration_provider set. Org members must be able
-- to READ their partner's built-in package + its versions so they can deploy it to
-- their own devices, and partner admins must be able to upload the S1 installer
-- version. The 2026-06-26-a dual-axis policy only granted partner-axis access via
-- breeze_has_partner_access (empty for org-scoped callers), so built-ins were
-- invisible/undeployable through the normal org surface. Broaden SELECT (both
-- tables) with an "org member reads own partner's built-in" branch, and add a
-- partner-write branch to software_versions for the S1 binary upload.
-- Writes to software_catalog stay strict (built-ins are provisioned in system
-- context); org members never insert/delete partner rows.

-- Also pin integration_provider to the known set (defense-in-depth; no shipped rows).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_catalog_integration_provider_chk'
      AND conrelid = 'software_catalog'::regclass
  ) THEN
    ALTER TABLE software_catalog
      ADD CONSTRAINT software_catalog_integration_provider_chk
      CHECK (integration_provider IS NULL OR integration_provider IN ('huntress', 'sentinelone'));
  END IF;
END $$;

-- software_catalog: broaden SELECT only (keep insert/update/delete from 2026-06-26-a).
DROP POLICY IF EXISTS software_catalog_dual_isolation_select ON software_catalog;
CREATE POLICY software_catalog_dual_isolation_select ON software_catalog
  FOR SELECT USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
    OR (
      integration_provider IS NOT NULL
      AND partner_id IN (
        SELECT o.partner_id FROM organizations o
        WHERE o.id = ANY(public.breeze_accessible_org_ids())
      )
    )
  );

-- software_versions: rebuild all four policies. SELECT gains both the partner-axis
-- branch and the org-member-reads-own-partner's-built-in branch; writes gain the
-- partner-axis branch (S1 installer upload by a partner admin). breeze_has_org_access
-- returns FALSE for a NULL org_id, so built-in rows fall through to the new branches.
DROP POLICY IF EXISTS breeze_org_isolation_select ON software_versions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_versions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_versions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_versions;

CREATE POLICY breeze_org_isolation_select ON software_versions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_versions.catalog_id
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
CREATE POLICY breeze_org_isolation_insert ON software_versions FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_versions.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
CREATE POLICY breeze_org_isolation_update ON software_versions FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_versions.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_versions.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
CREATE POLICY breeze_org_isolation_delete ON software_versions FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_versions.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
