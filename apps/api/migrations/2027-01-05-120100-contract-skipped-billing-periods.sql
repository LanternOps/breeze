-- Partner billing toggle PR 1: the contract_skipped_billing_periods ledger.
-- Spec: docs/superpowers/specs/billing/2026-10-16-partner-billing-enabled-design.md
-- §6.1 (re-enabling billing: skipped periods) and Q7 (§10).
--
-- One row per billing period of an active contract that was skipped while the
-- partner had Billing off. Manual review only: a flag plus a note, nothing
-- more. A row NEVER generates an invoice, charge or autopay attempt.
--
-- Tenancy: RLS Shape 1 (direct org_id, breeze_has_org_access). Operational
-- customer history, not a partner-wide configuration table, so the
-- org-XOR-partner rule does not apply. The partner is derived through the
-- contract. Not append-only: org merge repoints org_id by UPDATE and the
-- resolved flag/note are edited in place.
--
-- Writes no rows, so no system-scope election is needed.

CREATE TABLE IF NOT EXISTS contract_skipped_billing_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  contract_id uuid NOT NULL,
  -- Half-open [period_start, period_end).
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- No default: the writer must name why. One reason today.
  reason text NOT NULL,
  resolved boolean NOT NULL DEFAULT false,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_skipped_billing_periods_period_chk CHECK (period_end > period_start),
  CONSTRAINT contract_skipped_billing_periods_reason_chk CHECK (reason IN ('billing_disabled')),
  CONSTRAINT contract_skipped_billing_periods_note_chk CHECK (char_length(resolution_note) <= 2000)
);

-- Composite FK: the same-org guarantee is the FK, not RLS. DEFERRABLE INITIALLY
-- IMMEDIATE because org merge repoints parent and child org_id in separate
-- statements under SET CONSTRAINTS ALL DEFERRED (a non-deferrable one aborts the
-- merge with 23503). DROP + re-ADD converges any drifted shape on re-apply.
ALTER TABLE contract_skipped_billing_periods DROP CONSTRAINT IF EXISTS contract_skipped_billing_periods_contract_org_fk;
ALTER TABLE contract_skipped_billing_periods ADD CONSTRAINT contract_skipped_billing_periods_contract_org_fk
  FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- The idempotency key (repeat enable/disable cycles must not duplicate rows);
-- its leading column also serves the contract FK's child side.
CREATE UNIQUE INDEX IF NOT EXISTS contract_skipped_billing_periods_contract_period_uq
  ON contract_skipped_billing_periods (contract_id, period_start);
CREATE INDEX IF NOT EXISTS contract_skipped_billing_periods_org_idx
  ON contract_skipped_billing_periods (org_id);

-- RLS: Shape 1, verbatim from contract_billing_periods
-- (2026-06-15-d-recurring-contracts.sql).
ALTER TABLE contract_skipped_billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_skipped_billing_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_skipped_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_skipped_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_skipped_billing_periods;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_skipped_billing_periods;
CREATE POLICY breeze_org_isolation_select ON contract_skipped_billing_periods
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_skipped_billing_periods
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_skipped_billing_periods
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_skipped_billing_periods
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE is required for the org-merge repoint and the resolve flag/note.
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_skipped_billing_periods TO breeze_app;
