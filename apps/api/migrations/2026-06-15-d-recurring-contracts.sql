-- Recurring Contracts (billing program sub-project 3). Idempotent throughout.
-- Depends on invoices/catalog_items/sites from earlier migrations (sorts after 2026-06-15-c-invoice-documents.sql).

DO $$ BEGIN
  CREATE TYPE contract_status AS ENUM ('draft','active','paused','cancelled','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contract_billing_timing AS ENUM ('advance','arrears');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contract_line_type AS ENUM ('flat','per_device','per_seat','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  status contract_status NOT NULL DEFAULT 'draft',
  billing_timing contract_billing_timing NOT NULL DEFAULT 'advance',
  interval_months INTEGER NOT NULL CHECK (interval_months > 0),
  start_date DATE NOT NULL,
  end_date DATE,
  next_billing_at DATE,
  auto_issue BOOLEAN NOT NULL DEFAULT FALSE,
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  notes TEXT,
  terms TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS contracts_org_status_idx ON contracts (org_id, status);
CREATE INDEX IF NOT EXISTS contracts_partner_status_idx ON contracts (partner_id, status);
CREATE INDEX IF NOT EXISTS contracts_next_billing_idx ON contracts (next_billing_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS contract_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  line_type contract_line_type NOT NULL,
  description TEXT NOT NULL,
  catalog_item_id UUID,
  unit_price NUMERIC(12,2) NOT NULL,
  manual_quantity NUMERIC(12,2),
  site_id UUID,
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_catalog_item_fkey
    FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS contract_lines_contract_sort_idx ON contract_lines (contract_id, sort_order);
CREATE INDEX IF NOT EXISTS contract_lines_org_idx ON contract_lines (org_id);

CREATE TABLE IF NOT EXISTS contract_billing_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  invoice_id UUID,
  generated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE contract_billing_periods ADD CONSTRAINT contract_billing_periods_invoice_fkey
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS contract_billing_periods_contract_period_uq
  ON contract_billing_periods (contract_id, period_start);
CREATE INDEX IF NOT EXISTS contract_billing_periods_org_idx ON contract_billing_periods (org_id);

-- RLS: shape 1 (direct/denormalized org_id) on all three tables.
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contracts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contracts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contracts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contracts;
CREATE POLICY breeze_org_isolation_select ON contracts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contracts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contracts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contracts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE contract_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_lines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_lines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_lines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_lines;
CREATE POLICY breeze_org_isolation_select ON contract_lines
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_lines
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_lines
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_lines
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE contract_billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_billing_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_billing_periods;
CREATE POLICY breeze_org_isolation_select ON contract_billing_periods
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_billing_periods
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_billing_periods
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_billing_periods
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'contracts' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('contracts', 'read', 'View contracts, lines, and billing-period history');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'contracts' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('contracts', 'write', 'Create/edit/delete draft contracts and lines');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'contracts' AND action = 'manage') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('contracts', 'manage', 'Activate/pause/resume/cancel contracts and generate invoices');
  END IF;
END $$;

-- Seed contract permissions (read/write/manage) onto the built-in PARTNER roles that
-- already hold tickets:write, so the same staff who manage tickets can manage contracts
-- out of the box. Idempotent: the NOT EXISTS guard skips any (role, permission) pair
-- that's already granted, so re-applying this migration is a no-op.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'contracts' AND p2.action IN ('read','write','manage')
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
