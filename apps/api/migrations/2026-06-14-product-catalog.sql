-- Product Catalog: items, per-org pricing, bundles. Plus ticket_parts.catalog_item_id
-- and catalog permissions. Idempotent; partner-axis (shape 3) + org-axis (shape 1).

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE catalog_item_type AS ENUM ('hardware','software','service');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE catalog_billing_type AS ENUM ('one_time','recurring');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. catalog_items (partner-axis)
CREATE TABLE IF NOT EXISTS catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  item_type catalog_item_type NOT NULL,
  name VARCHAR(255) NOT NULL,
  sku VARCHAR(100),
  description TEXT,
  billing_type catalog_billing_type NOT NULL DEFAULT 'one_time',
  unit_price NUMERIC(12,2) NOT NULL,
  cost_basis NUMERIC(12,2),
  markup_percent NUMERIC(6,2),
  unit_of_measure VARCHAR(50) NOT NULL DEFAULT 'each',
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  tax_category VARCHAR(100),
  is_bundle BOOLEAN NOT NULL DEFAULT FALSE,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS catalog_items_partner_type_idx ON catalog_items (partner_id, item_type);
CREATE INDEX IF NOT EXISTS catalog_items_partner_active_idx ON catalog_items (partner_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_partner_sku_uq ON catalog_items (partner_id, sku) WHERE sku IS NOT NULL;

-- 3. catalog_item_org_pricing (org-axis, direct org_id)
CREATE TABLE IF NOT EXISTS catalog_item_org_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  unit_price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_item_org_pricing_item_org_uq ON catalog_item_org_pricing (catalog_item_id, org_id);
CREATE INDEX IF NOT EXISTS catalog_item_org_pricing_org_idx ON catalog_item_org_pricing (org_id);

-- 4. catalog_bundle_components (partner-axis via denormalized partner_id)
CREATE TABLE IF NOT EXISTS catalog_bundle_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  bundle_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  component_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  show_on_invoice BOOLEAN NOT NULL DEFAULT FALSE,
  revenue_allocation NUMERIC(12,2),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_bundle_components_bundle_comp_uq ON catalog_bundle_components (bundle_item_id, component_item_id);
CREATE INDEX IF NOT EXISTS catalog_bundle_components_partner_idx ON catalog_bundle_components (partner_id);

-- 5. RLS: catalog_items (partner-axis + system bypass)
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY catalog_items_partner_access ON catalog_items
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. RLS: catalog_bundle_components (partner-axis via denormalized partner_id + system bypass)
ALTER TABLE catalog_bundle_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_bundle_components FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY catalog_bundle_components_partner_access ON catalog_bundle_components
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7. RLS: catalog_item_org_pricing (org-axis)
ALTER TABLE catalog_item_org_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_org_pricing FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON catalog_item_org_pricing;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON catalog_item_org_pricing;
DROP POLICY IF EXISTS breeze_org_isolation_update ON catalog_item_org_pricing;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON catalog_item_org_pricing;
CREATE POLICY breeze_org_isolation_select ON catalog_item_org_pricing
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON catalog_item_org_pricing
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON catalog_item_org_pricing
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON catalog_item_org_pricing
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 8. ticket_parts.catalog_item_id
ALTER TABLE ticket_parts ADD COLUMN IF NOT EXISTS catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL;

-- 9. catalog permissions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'catalog' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('catalog', 'read', 'View product catalog items and pricing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'catalog' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('catalog', 'write', 'Create and update catalog items, pricing, and bundles');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'catalog' AND action = 'delete') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('catalog', 'delete', 'Archive/delete catalog items');
  END IF;
END $$;

-- 10. Grant catalog perms to roles already holding the matching tickets perm,
--     restricted to partner-scope system roles (catalog is partner-internal).
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'read'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'catalog' AND p2.action = 'read'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'catalog' AND p2.action = 'write'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'catalog' AND p2.action = 'delete'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
