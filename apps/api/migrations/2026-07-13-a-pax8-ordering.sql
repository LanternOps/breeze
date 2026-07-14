-- Pax8 ordering: staged intent ledger.
-- Pax8 has no idempotency key and no order status field, so THIS TABLE — not
-- Pax8 — is the record of whether money was spent. A line is claimed
-- (submit_state='in_flight') in a committed txn before the HTTP call.
-- Partner-axis (RLS shape 3), matching the five existing pax8_* tables:
-- org_id is a linkage column, never the tenancy axis.

CREATE TABLE IF NOT EXISTS pax8_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL,
  pax8_company_id VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  source VARCHAR(10) NOT NULL DEFAULT 'direct',
  source_quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  dedupe_key VARCHAR(120) NOT NULL,
  pax8_order_id VARCHAR(64),
  error TEXT,
  created_by UUID REFERENCES users(id),
  submitted_by UUID REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pax8_orders_status_chk CHECK (status IN (
    'draft','awaiting_details','ready','submitting','completed','partially_failed','failed','cancelled')),
  CONSTRAINT pax8_orders_source_chk CHECK (source IN ('direct','quote')),
  CONSTRAINT pax8_orders_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES pax8_integrations(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT pax8_orders_org_partner_fkey
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);

-- The idempotency guard. A concurrent submit of the same intent loses this race.
CREATE UNIQUE INDEX IF NOT EXISTS pax8_orders_dedupe_key_uq
  ON pax8_orders(partner_id, dedupe_key);
CREATE INDEX IF NOT EXISTS pax8_orders_partner_idx ON pax8_orders(partner_id);
CREATE INDEX IF NOT EXISTS pax8_orders_org_idx ON pax8_orders(org_id);
CREATE INDEX IF NOT EXISTS pax8_orders_status_idx ON pax8_orders(partner_id, status);
CREATE INDEX IF NOT EXISTS pax8_orders_quote_idx ON pax8_orders(source_quote_id);
-- Target for the order_lines composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS pax8_orders_id_partner_idx ON pax8_orders(id, partner_id);

CREATE TABLE IF NOT EXISTS pax8_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL,
  submit_state VARCHAR(20) NOT NULL DEFAULT 'pending',
  pax8_product_id VARCHAR(64),
  catalog_item_id UUID,
  billing_term VARCHAR(20),
  commitment_term_id VARCHAR(64),
  quantity NUMERIC(12,2),
  provisioning_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_subscription_id VARCHAR(64),
  cancel_date DATE,
  result_subscription_id VARCHAR(64),
  contract_line_id UUID,
  source_quote_line_id UUID,
  error TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pax8_order_lines_action_chk CHECK (action IN (
    'new_subscription','change_quantity','cancel')),
  CONSTRAINT pax8_order_lines_state_chk CHECK (submit_state IN (
    'pending','in_flight','succeeded','failed','needs_reconcile')),
  -- Each action carries a different payload; enforce the shape rather than
  -- trusting the service layer. A cancel with a quantity is a bug, not data.
  CONSTRAINT pax8_order_lines_action_payload_chk CHECK (
    (action = 'new_subscription'
       AND pax8_product_id IS NOT NULL AND billing_term IS NOT NULL
       AND quantity IS NOT NULL AND quantity > 0 AND target_subscription_id IS NULL)
    OR (action = 'change_quantity'
       AND target_subscription_id IS NOT NULL AND quantity IS NOT NULL AND quantity >= 0)
    OR (action = 'cancel'
       AND target_subscription_id IS NOT NULL AND quantity IS NULL)
  ),
  CONSTRAINT pax8_order_lines_order_partner_fkey
    FOREIGN KEY (order_id, partner_id)
    REFERENCES pax8_orders(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT pax8_order_lines_org_partner_fkey
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT pax8_order_lines_catalog_item_partner_fkey
    FOREIGN KEY (catalog_item_id, partner_id)
    REFERENCES catalog_items(id, partner_id) ON DELETE SET NULL,
  CONSTRAINT pax8_order_lines_contract_line_org_fkey
    FOREIGN KEY (contract_line_id, org_id)
    REFERENCES contract_lines(id, org_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pax8_order_lines_order_idx ON pax8_order_lines(order_id);
CREATE INDEX IF NOT EXISTS pax8_order_lines_partner_idx ON pax8_order_lines(partner_id);
CREATE INDEX IF NOT EXISTS pax8_order_lines_org_idx ON pax8_order_lines(org_id);
CREATE INDEX IF NOT EXISTS pax8_order_lines_contract_line_idx ON pax8_order_lines(contract_line_id);
-- Finds lines stranded mid-flight (crash between claim and result).
CREATE INDEX IF NOT EXISTS pax8_order_lines_inflight_idx
  ON pax8_order_lines(submit_state) WHERE submit_state IN ('in_flight','needs_reconcile');

ALTER TABLE pax8_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE pax8_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax8_order_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_orders;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_orders;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_orders;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_orders;
CREATE POLICY breeze_partner_isolation_select ON pax8_orders
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_orders
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_orders
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_orders
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS breeze_partner_isolation_select ON pax8_order_lines;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON pax8_order_lines;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON pax8_order_lines;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON pax8_order_lines;
CREATE POLICY breeze_partner_isolation_select ON pax8_order_lines
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON pax8_order_lines
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON pax8_order_lines
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON pax8_order_lines
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
