-- Order tracking for won quotes: PO-style header + per-line allocations.
-- Spec: docs/superpowers/specs/billing/2026-08-03-quote-procurement-breakdown-design.md
-- Composite FKs prove header/allocation/quote-line all share one quote + org
-- (same construction as pax8_order_lines). All FKs cascade so the org-erasure
-- cascade order can never hit an FK violation regardless of list position.

-- Composite FK targets need unique indexes on the referenced columns.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_id_org_uq ON quotes (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_lines_id_quote_uq ON quote_lines (id, quote_id);

CREATE TABLE IF NOT EXISTS quote_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  procurement_source varchar(40),
  vendor_name varchar(255),
  order_ref varchar(120),
  ordered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ordered_at timestamp NOT NULL DEFAULT now(),
  notes text,
  client_request_id uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT quote_orders_quote_org_fkey FOREIGN KEY (quote_id, org_id)
    REFERENCES quotes (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS quote_orders_quote_idx ON quote_orders (quote_id);
CREATE INDEX IF NOT EXISTS quote_orders_org_idx ON quote_orders (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_orders_id_quote_org_uq ON quote_orders (id, quote_id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_orders_client_request_uq
  ON quote_orders (quote_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quote_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  quote_line_id uuid NOT NULL,
  ordered_qty numeric(12,2) NOT NULL,
  received_qty numeric(12,2) NOT NULL DEFAULT 0,
  tracking_number varchar(120),
  eta date,
  received_at timestamp,
  cancelled_at timestamp,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT quote_order_lines_order_fkey FOREIGN KEY (order_id, quote_id, org_id)
    REFERENCES quote_orders (id, quote_id, org_id) ON DELETE CASCADE,
  CONSTRAINT quote_order_lines_quote_line_fkey FOREIGN KEY (quote_line_id, quote_id)
    REFERENCES quote_lines (id, quote_id) ON DELETE CASCADE,
  CONSTRAINT quote_order_lines_qty_chk CHECK (ordered_qty > 0 AND received_qty >= 0 AND received_qty <= ordered_qty)
);
CREATE INDEX IF NOT EXISTS quote_order_lines_order_idx ON quote_order_lines (order_id);
CREATE INDEX IF NOT EXISTS quote_order_lines_org_idx ON quote_order_lines (org_id);
CREATE INDEX IF NOT EXISTS quote_order_lines_quote_line_idx ON quote_order_lines (quote_line_id);

-- Shape-1 org RLS, enabled + FORCED in the creating migration (never deferred).
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['quote_orders','quote_order_lines'] LOOP
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO breeze_app', tbl);
  END LOOP;
END $$;
