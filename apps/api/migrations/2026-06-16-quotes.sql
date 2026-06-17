-- Quotes / Proposals (billing program sub-project 4). Idempotent throughout.
-- Depends on partners/organizations/users/catalog_items from earlier migrations.

-- Catalog subscription fields (minimal, quotes-driven).
DO $$ BEGIN
  CREATE TYPE catalog_billing_frequency AS ENUM ('monthly','quarterly','annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS billing_frequency catalog_billing_frequency;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS commitment_term_months INTEGER;

DO $$ BEGIN CREATE TYPE quote_status AS ENUM
  ('draft','sent','viewed','accepted','declined','expired','converted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE quote_line_source_type AS ENUM ('catalog','bundle','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE quote_line_recurrence AS ENUM ('one_time','monthly','annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE quote_block_type AS ENUM ('heading','rich_text','image','line_items');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  site_id UUID,
  quote_number VARCHAR(40),
  status quote_status NOT NULL DEFAULT 'draft',
  currency_code CHAR(3) NOT NULL DEFAULT 'USD',
  issue_date DATE,
  expiry_date DATE,
  accepted_at TIMESTAMP,
  declined_at TIMESTAMP,
  converted_at TIMESTAMP,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6,3),
  tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  one_time_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  monthly_recurring_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  annual_recurring_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  bill_to_name VARCHAR(255),
  bill_to_address JSONB,
  bill_to_tax_id VARCHAR(100),
  intro_notes TEXT,
  terms TEXT,
  converted_invoice_id UUID,
  pdf_document_ref TEXT,
  pdf_sha256 CHAR(64),
  sent_at TIMESTAMP,
  first_viewed_at TIMESTAMP,
  viewed_at TIMESTAMP,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_site_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_converted_invoice_fkey
    FOREIGN KEY (converted_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- dual-axis composite FK: (org_id, partner_id) must reference a real org of that partner
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_org_partner_fkey
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS quotes_org_status_idx ON quotes (org_id, status);
CREATE INDEX IF NOT EXISTS quotes_partner_status_idx ON quotes (partner_id, status);
CREATE INDEX IF NOT EXISTS quotes_org_issue_date_idx ON quotes (org_id, issue_date);
CREATE INDEX IF NOT EXISTS quotes_expiry_idx ON quotes (expiry_date) WHERE status IN ('sent','viewed');
CREATE UNIQUE INDEX IF NOT EXISTS quotes_partner_number_uq ON quotes (partner_id, quote_number) WHERE quote_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quotes_id_org_uq ON quotes (id, org_id);

CREATE TABLE IF NOT EXISTS quote_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  block_type quote_block_type NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_blocks_quote_sort_idx ON quote_blocks (quote_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_blocks_org_idx ON quote_blocks (org_id);

CREATE TABLE IF NOT EXISTS quote_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  block_id UUID REFERENCES quote_blocks(id) ON DELETE SET NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  source_type quote_line_source_type NOT NULL,
  catalog_item_id UUID,
  parent_line_id UUID REFERENCES quote_lines(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  customer_visible BOOLEAN NOT NULL DEFAULT TRUE,
  line_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  recurrence quote_line_recurrence NOT NULL DEFAULT 'one_time',
  term_months INTEGER,
  billing_frequency VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_catalog_item_fkey
    FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS quote_lines_quote_sort_idx ON quote_lines (quote_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_lines_block_idx ON quote_lines (block_id);
CREATE INDEX IF NOT EXISTS quote_lines_org_idx ON quote_lines (org_id);

CREATE TABLE IF NOT EXISTS quote_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  image_data BYTEA NOT NULL,
  mime VARCHAR(64) NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_images_quote_idx ON quote_images (quote_id);
CREATE INDEX IF NOT EXISTS quote_images_org_idx ON quote_images (org_id);

CREATE TABLE IF NOT EXISTS quote_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  signer_name VARCHAR(255) NOT NULL,
  signer_email VARCHAR(255),
  signed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ip_address VARCHAR(64),
  user_agent TEXT,
  quote_sha256 CHAR(64) NOT NULL,
  acceptance_token_jti VARCHAR(128),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_acceptances_quote_idx ON quote_acceptances (quote_id);
CREATE INDEX IF NOT EXISTS quote_acceptances_org_idx ON quote_acceptances (org_id);

CREATE TABLE IF NOT EXISTS partner_quote_sequences (
  partner_id UUID NOT NULL REFERENCES partners(id),
  year INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, year)
);

-- RLS: shape 1 (direct org_id) on the five org-scoped tables.
-- partner_quote_sequences is partner-axis (shape 3) — handled below.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['quotes','quote_blocks','quote_lines','quote_images','quote_acceptances']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_select ON %I FOR SELECT USING (public.breeze_has_org_access(org_id))', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_insert ON %I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_update ON %I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))', tbl);
    EXECUTE format('CREATE POLICY breeze_org_isolation_delete ON %I FOR DELETE USING (public.breeze_has_org_access(org_id))', tbl);
  END LOOP;
END $$;

-- partner_quote_sequences: partner-axis flat policy (mirror partner_invoice_sequences).
ALTER TABLE partner_quote_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_quote_sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON partner_quote_sequences;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON partner_quote_sequences;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON partner_quote_sequences;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON partner_quote_sequences;
CREATE POLICY breeze_partner_isolation_select ON partner_quote_sequences
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON partner_quote_sequences
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON partner_quote_sequences
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON partner_quote_sequences
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- Permissions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='quotes' AND action='read') THEN
    INSERT INTO permissions (resource, action, description) VALUES ('quotes','read','View quotes/proposals, lines, and blocks');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='quotes' AND action='write') THEN
    INSERT INTO permissions (resource, action, description) VALUES ('quotes','write','Create/edit/delete draft quotes, lines, and blocks');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='quotes' AND action='send') THEN
    INSERT INTO permissions (resource, action, description) VALUES ('quotes','send','Issue and send quotes to customers');
  END IF;
END $$;

-- Seed read/write/send onto partner-scope system roles that hold tickets:write
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource='tickets' AND p1.action='write'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope='partner'
JOIN permissions p2 ON p2.resource='quotes' AND p2.action IN ('read','write','send')
WHERE NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id);

-- Seed read onto partner-scope system roles that hold only tickets:read (viewers)
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource='tickets' AND p1.action='read'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope='partner'
JOIN permissions p2 ON p2.resource='quotes' AND p2.action='read'
WHERE NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id);
