CREATE TABLE IF NOT EXISTS pax8_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  name varchar(200) NOT NULL,
  client_id_encrypted text NOT NULL,
  client_secret_encrypted text NOT NULL,
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  api_base_url varchar(300) NOT NULL DEFAULT 'https://api.pax8.com/v1',
  token_url varchar(300) NOT NULL,
  webhook_secret_encrypted text,
  is_active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_sync_status varchar(20),
  last_sync_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pax8_integrations_partner_active_idx
  ON pax8_integrations(partner_id)
  WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS pax8_integrations_id_partner_idx
  ON pax8_integrations(id, partner_id);

CREATE TABLE IF NOT EXISTS pax8_company_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  pax8_company_id varchar(64) NOT NULL,
  pax8_company_name varchar(255) NOT NULL,
  status varchar(40),
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ignored boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pax8_company_mappings_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES pax8_integrations(id, partner_id)
    ON DELETE CASCADE,
  CONSTRAINT pax8_company_mappings_org_partner_fkey
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS pax8_company_mappings_integration_company_uq
  ON pax8_company_mappings(integration_id, pax8_company_id);
CREATE INDEX IF NOT EXISTS pax8_company_mappings_integration_idx
  ON pax8_company_mappings(integration_id);
CREATE INDEX IF NOT EXISTS pax8_company_mappings_partner_idx
  ON pax8_company_mappings(partner_id);
CREATE INDEX IF NOT EXISTS pax8_company_mappings_org_idx
  ON pax8_company_mappings(org_id);

CREATE TABLE IF NOT EXISTS pax8_subscription_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  pax8_company_id varchar(64) NOT NULL,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  pax8_subscription_id varchar(64) NOT NULL,
  product_id varchar(64),
  product_name varchar(255),
  vendor_name varchar(255),
  vendor_sku_id varchar(120),
  status varchar(40),
  billing_term varchar(40),
  quantity numeric(12,2) NOT NULL DEFAULT 0,
  unit_price numeric(12,2),
  unit_cost numeric(12,2),
  currency_code char(3),
  start_date date,
  end_date date,
  billing_start date,
  commitment_term_end_date date,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pax8_subscription_snapshots_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES pax8_integrations(id, partner_id)
    ON DELETE CASCADE,
  CONSTRAINT pax8_subscription_snapshots_org_partner_fkey
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS pax8_subscription_snapshots_integration_sub_uq
  ON pax8_subscription_snapshots(integration_id, pax8_subscription_id);
CREATE INDEX IF NOT EXISTS pax8_subscription_snapshots_integration_idx
  ON pax8_subscription_snapshots(integration_id);
CREATE INDEX IF NOT EXISTS pax8_subscription_snapshots_partner_idx
  ON pax8_subscription_snapshots(partner_id);
CREATE INDEX IF NOT EXISTS pax8_subscription_snapshots_org_idx
  ON pax8_subscription_snapshots(org_id);
CREATE INDEX IF NOT EXISTS pax8_subscription_snapshots_company_idx
  ON pax8_subscription_snapshots(integration_id, pax8_company_id);
CREATE INDEX IF NOT EXISTS pax8_subscription_snapshots_product_idx
  ON pax8_subscription_snapshots(integration_id, product_id);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_id_partner_uq
  ON catalog_items(id, partner_id);

CREATE TABLE IF NOT EXISTS pax8_product_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  pax8_product_id varchar(64) NOT NULL,
  vendor_sku_id varchar(120),
  product_name varchar(255),
  catalog_item_id uuid REFERENCES catalog_items(id) ON DELETE SET NULL,
  sync_pricing boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pax8_product_mappings_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES pax8_integrations(id, partner_id)
    ON DELETE CASCADE,
  CONSTRAINT pax8_product_mappings_catalog_item_partner_fkey
    FOREIGN KEY (catalog_item_id, partner_id)
    REFERENCES catalog_items(id, partner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS pax8_product_mappings_integration_product_uq
  ON pax8_product_mappings(integration_id, pax8_product_id);
CREATE INDEX IF NOT EXISTS pax8_product_mappings_partner_idx
  ON pax8_product_mappings(partner_id);
CREATE INDEX IF NOT EXISTS pax8_product_mappings_catalog_item_idx
  ON pax8_product_mappings(catalog_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS contract_lines_id_org_uq
  ON contract_lines(id, org_id);

CREATE TABLE IF NOT EXISTS pax8_contract_line_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  subscription_snapshot_id uuid NOT NULL REFERENCES pax8_subscription_snapshots(id) ON DELETE CASCADE,
  contract_line_id uuid NOT NULL REFERENCES contract_lines(id) ON DELETE CASCADE,
  sync_enabled boolean NOT NULL DEFAULT false,
  last_applied_quantity numeric(12,2),
  last_applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pax8_contract_line_links_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES pax8_integrations(id, partner_id)
    ON DELETE CASCADE,
  CONSTRAINT pax8_contract_line_links_org_partner_fkey
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
    ON DELETE CASCADE,
  CONSTRAINT pax8_contract_line_links_contract_line_org_fkey
    FOREIGN KEY (contract_line_id, org_id)
    REFERENCES contract_lines(id, org_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS pax8_contract_line_links_subscription_uq
  ON pax8_contract_line_links(subscription_snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS pax8_contract_line_links_contract_line_uq
  ON pax8_contract_line_links(contract_line_id);
CREATE INDEX IF NOT EXISTS pax8_contract_line_links_partner_idx
  ON pax8_contract_line_links(partner_id);
CREATE INDEX IF NOT EXISTS pax8_contract_line_links_org_idx
  ON pax8_contract_line_links(org_id);

ALTER TABLE pax8_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_integrations FORCE ROW LEVEL SECURITY;
ALTER TABLE pax8_company_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_company_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE pax8_subscription_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_subscription_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE pax8_product_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_product_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE pax8_contract_line_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_contract_line_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_integrations;
CREATE POLICY breeze_partner_isolation_select ON pax8_integrations
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_integrations
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_integrations
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_integrations
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_company_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_company_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_company_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_company_mappings;
CREATE POLICY breeze_partner_isolation_select ON pax8_company_mappings
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_company_mappings
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_company_mappings
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_company_mappings
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_subscription_snapshots;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_subscription_snapshots;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_subscription_snapshots;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_subscription_snapshots;
CREATE POLICY breeze_partner_isolation_select ON pax8_subscription_snapshots
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_subscription_snapshots
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_subscription_snapshots
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_subscription_snapshots
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_product_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_product_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_product_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_product_mappings;
CREATE POLICY breeze_partner_isolation_select ON pax8_product_mappings
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_product_mappings
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_product_mappings
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_product_mappings
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_contract_line_links;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_contract_line_links;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_contract_line_links;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_contract_line_links;
CREATE POLICY breeze_partner_isolation_select ON pax8_contract_line_links
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_contract_line_links
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_contract_line_links
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_contract_line_links
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
