-- Invoice Engine (billing program sub-project 2). Idempotent throughout.
-- Depends on catalog enums/tables from 2026-06-14-product-catalog.sql (sorts first).
-- Dated 2026-06-15 so it lexically sorts AFTER 2026-06-14-product-catalog.sql
-- (a same-day '-b-' infix would sort BEFORE 'product-catalog' because '-' < 'p').

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft','sent','partially_paid','overdue','paid','void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invoice_line_source_type AS ENUM ('time_entry','part','catalog','bundle','manual','contract');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash','check','bank_transfer','card','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  site_id UUID,
  invoice_number VARCHAR(40),
  status invoice_status NOT NULL DEFAULT 'draft',
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  issue_date DATE,
  due_date DATE,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6,3),
  tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  bill_to_name VARCHAR(255),
  bill_to_address JSONB,
  bill_to_tax_id VARCHAR(100),
  bill_to_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  terms TEXT,
  sent_at TIMESTAMP,
  first_viewed_at TIMESTAMP,
  viewed_at TIMESTAMP,
  paid_at TIMESTAMP,
  marked_overdue_at TIMESTAMP,
  voided_at TIMESTAMP,
  void_reason TEXT,
  replaces_invoice_id UUID,
  replaced_by_invoice_id UUID,
  pdf_document_ref TEXT,
  pdf_sha256 CHAR(64),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- self / cross-table FKs (SQL-only to avoid drizzle import cycles)
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_replaces_fkey
    FOREIGN KEY (replaces_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_replaced_by_fkey
    FOREIGN KEY (replaced_by_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS invoices_org_status_idx ON invoices (org_id, status);
CREATE INDEX IF NOT EXISTS invoices_partner_status_idx ON invoices (partner_id, status);
CREATE INDEX IF NOT EXISTS invoices_org_issue_date_idx ON invoices (org_id, issue_date);
CREATE INDEX IF NOT EXISTS invoices_due_overdue_idx ON invoices (due_date)
  WHERE status IN ('sent','partially_paid');
CREATE UNIQUE INDEX IF NOT EXISTS invoices_partner_number_uq ON invoices (partner_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  source_type invoice_line_source_type NOT NULL,
  source_id UUID,
  catalog_item_id UUID,
  parent_line_id UUID REFERENCES invoice_lines(id) ON DELETE CASCADE,
  ticket_id UUID,
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  cost_basis NUMERIC(12,2),
  revenue_allocation NUMERIC(12,2),
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  line_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_unapproved_time BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_catalog_item_fkey
    FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_ticket_fkey
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_sort_idx ON invoice_lines (invoice_id, sort_order);
CREATE INDEX IF NOT EXISTS invoice_lines_org_idx ON invoice_lines (org_id);
CREATE INDEX IF NOT EXISTS invoice_lines_source_idx ON invoice_lines (source_type, source_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method payment_method NOT NULL,
  reference VARCHAR(255),
  received_at DATE NOT NULL,
  recorded_by UUID REFERENCES users(id),
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_payments_org_idx ON invoice_payments (org_id);

CREATE TABLE IF NOT EXISTS partner_invoice_sequences (
  partner_id UUID NOT NULL REFERENCES partners(id),
  year INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, year)
);

-- RLS: shape 1 (direct/denormalized org_id) on the three core tables.
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoices;
CREATE POLICY breeze_org_isolation_select ON invoices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoices
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_lines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_lines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_lines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_lines;
CREATE POLICY breeze_org_isolation_select ON invoice_lines
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_lines
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_lines
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_lines
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_payments;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_payments;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_payments;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_payments;
CREATE POLICY breeze_org_isolation_select ON invoice_payments
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_payments
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_payments
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_payments
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- RLS: partner_invoice_sequences is partner-axis (shape 3), system bypass for allocation.
ALTER TABLE partner_invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_invoice_sequences FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY partner_invoice_sequences_partner_access ON partner_invoice_sequences
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Org/partner billing columns.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_id VARCHAR(100);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,3);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_line1 VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_line2 VARCHAR(255);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_city VARCHAR(120);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_region VARCHAR(120);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_postal_code VARCHAR(40);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address_country CHAR(2);

ALTER TABLE partners ADD COLUMN IF NOT EXISTS currency_code CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_tax_rate NUMERIC(6,3);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_number_prefix VARCHAR(12) NOT NULL DEFAULT 'INV';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_terms_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_footer TEXT;

-- Invoice permissions + grant to partner-scope system roles already holding tickets:write.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'read', 'View invoices, lines, and payments');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'write', 'Create/edit/delete draft invoices and lines, run assembly');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'send') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'send', 'Issue, send, void invoices and record payments');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'invoices' AND action = 'export') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('invoices', 'export', 'Download invoice PDF/CSV');
  END IF;
END $$;

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'invoices' AND p2.action IN ('read','write','send','export')
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
