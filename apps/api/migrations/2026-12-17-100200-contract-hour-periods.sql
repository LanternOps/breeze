-- #4547 W01 (block hours): the contract_hour_periods ledger.
-- Spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md §3
-- Contract: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md (C3).
--
-- One row per CLOSED block period: what the block included, what rolled in,
-- what was drawn, what overflowed, what rolled out. UNIQUE (contract_line_id,
-- period_start) is the idempotency key W02's close path relies on.
--
-- Tenancy: RLS Shape 1 (direct org_id, breeze_has_org_access). This is a
-- balance — a transactional record of one customer's prepaid entitlement — not
-- a configuration policy, so the org-XOR-partner rule does not apply (same
-- reasoning as contract_billing_periods and its siblings). Not append-only:
-- org merge repoints org_id by UPDATE, so UPDATE must stay legal.
--
-- Writes no rows, so no system-scope election is needed.

CREATE TABLE IF NOT EXISTS contract_hour_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_line_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  -- Half-open [period_start, period_end), the contract's billing period.
  period_start date NOT NULL,
  period_end date NOT NULL,
  included_hours numeric(12,2) NOT NULL,
  carried_in_hours numeric(12,2) NOT NULL,
  consumed_hours numeric(12,2) NOT NULL,
  overage_hours numeric(12,2) NOT NULL,
  carried_out_hours numeric(12,2) NOT NULL,
  -- Hours absorbed from entries stamped in a currency other than the
  -- contract's (Decision 8 flag).
  foreign_currency_hours numeric(12,2) NOT NULL DEFAULT 0,
  entry_count integer NOT NULL,
  -- Snapshots at close, so a later edit of the line cannot rewrite history.
  overage_unit_price numeric(12,2) NOT NULL,
  currency_code char(3) NOT NULL,
  -- NULL when overage_hours = 0. Deliberately NO CHECK tying the two: the
  -- invoice FK below is ON DELETE SET NULL, so a deleted draft must stay legal.
  overage_invoice_id uuid,
  close_source text NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_hour_periods_period_chk CHECK (period_end > period_start),
  CONSTRAINT contract_hour_periods_hours_nonneg_chk CHECK (
    included_hours >= 0 AND carried_in_hours >= 0 AND consumed_hours >= 0
    AND overage_hours >= 0 AND carried_out_hours >= 0 AND foreign_currency_hours >= 0
  ),
  CONSTRAINT contract_hour_periods_close_source_chk CHECK (close_source IN ('billing_run', 'close_out'))
);

-- Composite FKs: the same-org guarantee is the FK, not RLS. DEFERRABLE INITIALLY
-- IMMEDIATE because org merge repoints parent and child org_id in separate
-- statements under SET CONSTRAINTS ALL DEFERRED (a non-deferrable one aborts the
-- merge with 23503). DROP + re-ADD converges any drifted shape on re-apply.
ALTER TABLE contract_hour_periods DROP CONSTRAINT IF EXISTS contract_hour_periods_contract_org_fk;
ALTER TABLE contract_hour_periods ADD CONSTRAINT contract_hour_periods_contract_org_fk
  FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- RESTRICT: a block line with closed periods can never be hard-deleted (it is
-- retired instead, W03). Postgres reports it as 23503.
ALTER TABLE contract_hour_periods DROP CONSTRAINT IF EXISTS contract_hour_periods_line_org_fk;
ALTER TABLE contract_hour_periods ADD CONSTRAINT contract_hour_periods_line_org_fk
  FOREIGN KEY (contract_line_id, org_id) REFERENCES contract_lines (id, org_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;

-- The PG15 column list is mandatory: without it SET NULL nulls EVERY FK column
-- including the NOT NULL org_id, which aborts the invoice delete with 23502.
-- Same lesson as 2026-10-08-101200-billing-evidence.sql.
ALTER TABLE contract_hour_periods DROP CONSTRAINT IF EXISTS contract_hour_periods_invoice_org_fk;
ALTER TABLE contract_hour_periods ADD CONSTRAINT contract_hour_periods_invoice_org_fk
  FOREIGN KEY (overage_invoice_id, org_id) REFERENCES invoices (id, org_id)
  ON DELETE SET NULL (overage_invoice_id) DEFERRABLE INITIALLY IMMEDIATE;

-- The idempotency key; its leading column also serves the line FK's child side.
CREATE UNIQUE INDEX IF NOT EXISTS contract_hour_periods_line_period_uq
  ON contract_hour_periods (contract_line_id, period_start);
CREATE INDEX IF NOT EXISTS contract_hour_periods_org_idx ON contract_hour_periods (org_id);
-- Per-contract history, newest first; also the contract FK's child side.
CREATE INDEX IF NOT EXISTS contract_hour_periods_contract_idx
  ON contract_hour_periods (contract_id, period_start DESC);

-- RLS: Shape 1, verbatim from contract_billing_periods
-- (2026-06-15-d-recurring-contracts.sql).
ALTER TABLE contract_hour_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_hour_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_hour_periods;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_hour_periods;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_hour_periods;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_hour_periods;
CREATE POLICY breeze_org_isolation_select ON contract_hour_periods
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_hour_periods
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_hour_periods
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_hour_periods
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE is required for the org-merge repoint; see the header.
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_hour_periods TO breeze_app;
