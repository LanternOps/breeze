-- Service catalog foundation, R1 (#8325).
-- Spec: docs/superpowers/specs/ticketing/2026-10-10-service-catalog-design.md
--       sections 6.1 (configuration), 6.3 (security and lifecycle).
--
-- Adds the two configuration tables of the catalog layer:
--   service_catalogs        one owner: partner_id XOR org_id
--   service_catalog_items   one owner: partner_id XOR org_id, and the same owner
--                           as its catalog (enforced by composite FKs)
--
-- Initial delivery rule (spec 6.1): creation happens only at the partner level,
-- with a single catalog per partner. The org axis exists so a later wave can
-- add org-owned rows without a retrofit; nothing in this file creates them.
--
-- Tenancy: dual-axis config table (org XOR partner), per CLAUDE.md "Partner-Wide
-- First". RLS is enabled and FORCED in this same migration. Reads for org
-- sessions of partner-wide rows go through a SELECT-only branch keyed on the
-- caller own partner (breeze_current_partner_id()), so UPDATE/DELETE targeting
-- is unchanged.
--
-- Composite FKs that reference an org_id column are DEFERRABLE INITIALLY
-- IMMEDIATE so organization merge can defer constraints while it re-points rows.
--
-- Fully idempotent. Writes no rows (creates tables, indexes, policies, grants).

CREATE TABLE IF NOT EXISTS service_catalogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_catalogs_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT service_catalogs_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT service_catalogs_id_org_uq UNIQUE (id, org_id)
);

-- Single partner-owned catalog in the initial delivery (spec 6.1).
CREATE UNIQUE INDEX IF NOT EXISTS service_catalogs_one_per_partner
  ON service_catalogs (partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_catalogs_org_idx ON service_catalogs (org_id);

CREATE TABLE IF NOT EXISTS service_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_catalog_items_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  -- Same owner as the catalog. MATCH SIMPLE skips the check for the NULL axis,
  -- so a partner item is pinned to a partner catalog and an org item to an org catalog.
  CONSTRAINT service_catalog_items_catalog_partner_fk FOREIGN KEY (catalog_id, partner_id)
    REFERENCES service_catalogs (id, partner_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT service_catalog_items_catalog_org_fk FOREIGN KEY (catalog_id, org_id)
    REFERENCES service_catalogs (id, org_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS service_catalog_items_catalog_idx ON service_catalog_items (catalog_id);
CREATE INDEX IF NOT EXISTS service_catalog_items_partner_idx ON service_catalog_items (partner_id);
CREATE INDEX IF NOT EXISTS service_catalog_items_org_idx ON service_catalog_items (org_id);

-- RLS: enabled and forced together with creation (CLAUDE.md, tenancy shapes).
ALTER TABLE service_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_catalogs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_catalogs_owner_access ON service_catalogs;
CREATE POLICY service_catalogs_owner_access ON service_catalogs
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
-- Separate, additive, SELECT-only branch: org sessions read their own partner-wide rows.
DROP POLICY IF EXISTS service_catalogs_partner_wide_select ON service_catalogs;
CREATE POLICY service_catalogs_partner_wide_select ON service_catalogs
  FOR SELECT TO breeze_app
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

ALTER TABLE service_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_catalog_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_catalog_items_owner_access ON service_catalog_items;
CREATE POLICY service_catalog_items_owner_access ON service_catalog_items
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
DROP POLICY IF EXISTS service_catalog_items_partner_wide_select ON service_catalog_items;
CREATE POLICY service_catalog_items_partner_wide_select ON service_catalog_items
  FOR SELECT TO breeze_app
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- The API connects as the unprivileged breeze_app role; without these grants
-- every statement fails with 42501 regardless of the policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON service_catalogs TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_catalog_items TO breeze_app;
